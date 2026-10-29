/* ============================================================================
   ENCODING QUEUE: the VOD encode jobs, what runs now, what waits, what finished.
   (docs/ENCODING_QUEUE.md)

   /encode-jobs        Encoding now (progress), Waiting (in the order a worker
                       will take them, counting every account's encodes ahead
                       because the workers are shared), Finished recently.
   /encode-jobs/:id    One job: progress and timing, each output (renditions,
                       HLS and DASH, thumbnails, sprite sheets, the jobs it
                       queued after), the encoder's log, tailed while it runs,
                       and its attempts. Retry and cancel where they apply.

   It polls while something is moving (2 to 3 s) and slows down when nothing is.
   ========================================================================== */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type EncodeJobRow, type EncodeOutputs, type EncodeQueue, type JobLogLine, type OutputState } from '../api'
import { navigate, useRoute } from '../router'
import { Notice, useNotify } from '../notices'
import './encodeJobs.css'

const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`
const clock = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
const when = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString()
  return today ? clock(iso) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
function dur(ms: number) {
  if (!isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`
}
const since = (iso: string | null, now: number) => iso ? dur(now - Date.parse(iso)) : ''
const took = (j: { started_at: string | null; finished_at: string | null }) => j.started_at && j.finished_at ? dur(Date.parse(j.finished_at) - Date.parse(j.started_at)) : ''
const title = (j: EncodeJobRow) => j.asset_title || j.source_file || 'Untitled asset'

const JOB_TAG: Record<string, { cls: string; label: string }> = {
  queued: { cls: 'sched', label: 'Waiting' }, running: { cls: 'live', label: 'Encoding' },
  succeeded: { cls: 'idle', label: 'Done' }, failed: { cls: 'down', label: 'Failed' }, cancelled: { cls: 'warn', label: 'Cancelled' },
}
const JobTag = ({ state }: { state: string }) => { const t = JOB_TAG[state] ?? { cls: 'idle', label: state }; return <span className={`tag ${t.cls}`}>{t.label}</span> }

const OUT_LABEL: Record<OutputState, string> = { ok: 'Done', running: 'Writing', pending: 'Waiting', failed: 'Failed', skipped: 'Skipped', missing: 'Missing' }
const OutState = ({ s }: { s: OutputState }) => <span className={`ej-state ${s}`}><i />{OUT_LABEL[s] ?? s}</span>

/** Re-render every second for elapsed times. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [on])
  return now
}

export default function EncodeJobsPage() {
  const route = useRoute()
  const id = route.path.replace(/^\/+|\/+$/g, '').split('/')[1] ?? null
  return id ? <EncodeJobDetail key={id} id={decodeURIComponent(id)} /> : <EncodeQueueView />
}

// ---------------------------------------------------------------------------- THE QUEUE
function EncodeQueueView() {
  const [q, setQ] = useState<EncodeQueue | null>(null)
  const [err, setErr] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [busy, setBusy] = useState('')
  const notify = useNotify()
  const moving = !!q && (q.running.length > 0 || q.queued.length > 0)
  const now = useNow(moving)

  const load = () => api.encodeQueue(50).then(r => { setQ(r); setErr('') }).catch((e: any) => setErr(e.message))
  useEffect(() => { load() }, [])
  useEffect(() => { const t = setInterval(load, moving ? 3000 : 15000); return () => clearInterval(t) }, [moving])

  async function cancel(j: EncodeJobRow) {
    if (!window.confirm(`Cancel the encode of "${title(j)}"? The asset stays in the library without playable media until it is encoded again.`)) return
    setBusy(j.id)
    try { await api.cancelJob(j.id); notify({ kind: 'ok', message: `Cancelled the encode of "${title(j)}".` }); await load() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  async function retry(j: EncodeJobRow) {
    setBusy(j.id)
    try { await api.retryJob(j.id); notify({ kind: 'ok', message: `"${title(j)}" is back in the queue.` }); await load() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  const open = (j: EncodeJobRow) => navigate(`/encode-jobs/${j.id}`)
  const recent = (q?.recent ?? []).filter(j => !onlyFailed || j.state === 'failed')
  const failedCount = (q?.recent ?? []).filter(j => j.state === 'failed').length
  const othersAhead = q ? Math.max(0, q.platformBacklog - q.running.length - q.queued.length) : 0

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Encoding Queue</h1>
          <p>What is being encoded now, what is waiting and in which order, and what finished recently. Open a job for its outputs and the encoder's log.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div style={{ marginBottom: 12 }}><Notice kind="error" variant="compact" title="Couldn't load the queue." message={err} actions={[{ label: 'Retry', onClick: load }]} /></div>}
      {!q && !err && <div className="loading">Loading…</div>}
      {q && (
        <>
          <div className="sec-label">Encoding now{q.running.length ? ` · ${q.running.length}` : ''}</div>
          {q.running.length === 0 ? <div className="card ej-empty">Nothing is encoding right now.</div> : (
            <div className="ej-grid">
              {q.running.map(j => (
                <div key={j.id} className="card ej-run" role="link" tabIndex={0} onClick={() => open(j)} onKeyDown={e => { if (e.key === 'Enter') open(j) }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="t" style={{ flex: 1, minWidth: 0 }}>{title(j)}</div>
                    {j.attempts > 1 && <span className="tag warn">Attempt {j.attempts}</span>}
                  </div>
                  <div className="f">{j.source_file || 'source file not named'}</div>
                  <div className="ej-bar"><i style={{ width: `${Math.max(2, j.progress_pct)}%` }} /></div>
                  <div className="ej-note"><span className="n">{j.progress_note || 'starting'}</span><span className="mono">{j.progress_pct}% · {since(j.started_at, now)}</span></div>
                </div>
              ))}
            </div>
          )}

          <div className="ej-head-row">
            <div className="sec-label">Waiting{q.queued.length ? ` · ${q.queued.length}` : ''}</div>
            {othersAhead > 0 && <span className="ej-sub" style={{ marginTop: 0 }}>The workers are shared: {othersAhead} other encode{othersAhead === 1 ? '' : 's'} on the platform are also queued or running.</span>}
          </div>
          <div className="card">
            {q.queued.length === 0 ? <div className="ej-empty">Nothing is waiting.</div> : (
              <table className="ej-table">
                <thead><tr><th style={{ width: 60 }}>Place</th><th>Asset</th><th>Queued</th><th>Waiting</th><th /></tr></thead>
                <tbody>
                  {q.queued.map(j => {
                    const later = j.run_after && Date.parse(j.run_after) > now
                    return (
                      <tr key={j.id} onClick={() => open(j)}>
                        <td className="ej-pos">{j.position === 1 ? 'Next' : `#${j.position}`}</td>
                        <td><div style={{ fontWeight: 600 }}>{title(j)}</div><div className="ej-sub">{j.source_file}</div></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{when(j.created_at)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {since(j.created_at, now)}
                          {later && <div className="ej-sub">retry at {clock(j.run_after)}{j.last_error ? ' after an error' : ''}</div>}
                          {!later && j.attempts > 0 && <div className="ej-sub">attempt {j.attempts + 1} of {j.max_attempts}</div>}
                        </td>
                        <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                          <button className="btn ghost sm" disabled={busy === j.id} onClick={() => cancel(j)}>Cancel</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="ej-head-row">
            <div className="sec-label">Finished recently</div>
            <div className="ej-filter">
              <button className={`btn sm ${onlyFailed ? 'ghost' : 'primary'}`} onClick={() => setOnlyFailed(false)}>All</button>
              <button className={`btn sm ${onlyFailed ? 'primary' : 'ghost'}`} onClick={() => setOnlyFailed(true)}>Failed{failedCount ? ` · ${failedCount}` : ''}</button>
            </div>
          </div>
          <div className="card">
            {recent.length === 0 ? <div className="ej-empty">{onlyFailed ? 'No failed encodes recently.' : 'No encodes have finished recently.'}</div> : (
              <table className="ej-table">
                <thead><tr><th>Result</th><th>Asset</th><th>Outcome</th><th>Took</th><th>Finished</th><th /></tr></thead>
                <tbody>
                  {recent.map(j => (
                    <tr key={j.id} onClick={() => open(j)}>
                      <td><JobTag state={j.state} /></td>
                      <td><div style={{ fontWeight: 600 }}>{title(j)}</div><div className="ej-sub">{j.source_file}</div></td>
                      <td>{j.state === 'failed' ? <div className="ej-err" title={j.last_error ?? ''}>{j.last_error}</div>
                        : <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>{j.summary || (j.state === 'cancelled' ? 'Cancelled' : '')}</span>}</td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{took(j)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(j.finished_at)}</td>
                      <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        {(j.state === 'failed' || j.state === 'cancelled') && <button className="btn ghost sm" disabled={busy === j.id} onClick={() => retry(j)}>Retry</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------- ONE JOB
type JobFull = Awaited<ReturnType<typeof api.job>> & { payload?: any; claimed_by?: string | null; run_after?: string | null }

function EncodeJobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<JobFull | null>(null)
  const [outs, setOuts] = useState<EncodeOutputs | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const notify = useNotify()
  const live = job?.state === 'running' || job?.state === 'queued'
  const now = useNow(!!live)

  const loadJob = () => api.job(id).then(j => { setJob(j as JobFull); setErr('') }).catch((e: any) => setErr(e.message))
  const loadOuts = () => api.jobOutputs(id).then(setOuts).catch(() => { /* a job without an asset shows no outputs */ })
  useEffect(() => { loadJob(); loadOuts() /* eslint-disable-next-line */ }, [id])
  useEffect(() => {
    if (!live) return
    const a = setInterval(loadJob, 2000), b = setInterval(loadOuts, 4000)
    return () => { clearInterval(a); clearInterval(b) }
    // eslint-disable-next-line
  }, [live, id])
  // One more look when it finishes: the asset row is written at the end.
  const prevState = useRef<string | undefined>(undefined)
  useEffect(() => { if (prevState.current && prevState.current !== job?.state) loadOuts(); prevState.current = job?.state /* eslint-disable-next-line */ }, [job?.state])

  async function act(kind: 'retry' | 'cancel') {
    if (kind === 'cancel' && !window.confirm('Cancel this encode? The asset stays in the library without playable media until it is encoded again.')) return
    setBusy(kind)
    try { await (kind === 'retry' ? api.retryJob(id) : api.cancelJob(id)); notify({ kind: 'ok', message: kind === 'retry' ? 'Back in the queue.' : 'Cancelled.' }); await loadJob(); await loadOuts() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  const back = <button className="ej-back" onClick={() => navigate('/encode-jobs')}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>Encoding Queue</button>
  if (err && !job) return <div>{back}<Notice kind="error" title="Couldn't load this job." message={err} actions={[{ label: 'Retry', onClick: loadJob }]} /></div>
  if (!job) return <div>{back}<div className="loading">Loading…</div></div>
  if (job.type !== 'vod.encode') return <div>{back}<Notice kind="info" message={`This is a ${job.type} job, not a VOD encode.`} /></div>

  const p = job.payload ?? {}
  const file = String(p.sourcePath ?? '').split('/').pop() || null
  const name = outs?.asset.title || job.source_name || file || 'Untitled asset'
  const result = job.result ?? {}
  const pct = job.state === 'succeeded' ? 100 : job.progress_pct
  // GET /api/jobs/:id answers `attempts` as the attempt history, not the count.
  const tries: any[] = Array.isArray((job as any).attempts) ? (job as any).attempts : []

  return (
    <div>
      {back}
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{name} <JobTag state={job.state} /></h1>
          <p>{file ? <>Encoding <span className="mono">{file}</span></> : 'VOD encode'}{result.summary ? ` · ${result.summary}` : ''}</p>
        </div>
        <div className="spacer" />
        {outs?.asset.exists && <button className="btn ghost" onClick={() => navigate(`/vod?asset=${outs.asset.id}`)}>Open the asset</button>}
        {(job.state === 'failed' || job.state === 'cancelled') && <button className="btn primary" disabled={!!busy} onClick={() => act('retry')}>{busy === 'retry' ? 'Queuing…' : 'Retry'}</button>}
        {live && <button className="btn ghost danger" disabled={!!busy} onClick={() => act('cancel')}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel encode'}</button>}
      </div>

      {job.state === 'failed' && job.last_error && (
        <div style={{ marginBottom: 16 }}><Notice kind="error" title={`The encode failed${job.error_code ? ` (${job.error_code})` : ''}.`} message={job.last_error} /></div>
      )}
      {outs && !outs.asset.exists && <div style={{ marginBottom: 16 }}><Notice kind="warn" variant="compact" message="The asset this job encoded has been deleted. Its outputs are shown as they were last seen." /></div>}

      <div className="ej-detail">
        <div style={{ minWidth: 0 }}>
          <div className="card ej-card">
            <div className="sec-label">Progress</div>
            <div className={`ej-bar ${job.state === 'failed' ? 'fail' : job.state === 'succeeded' ? 'done' : ''}`} style={{ marginTop: 0 }}><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
            <div className="ej-note"><span className="n">{job.state === 'succeeded' ? 'Finished' : job.progress_note || (job.state === 'queued' ? 'Waiting for a worker' : '')}</span><span className="mono">{pct}%</span></div>
          </div>

          <div className="card ej-card">
            <div className="sec-label">Outputs</div>
            {!outs ? <div className="loading">Reading what was produced…</div> : <Outputs o={outs} />}
          </div>

          <LogPanel id={id} live={!!live} />
        </div>

        <div>
          <div className="card ej-card">
            <div className="sec-label">Job</div>
            <div className="kv"><span className="k">Queued</span><span className="v">{when(job.created_at)}</span></div>
            <div className="kv"><span className="k">Started</span><span className="v">{when(job.started_at) || '—'}</span></div>
            <div className="kv"><span className="k">{job.finished_at ? 'Finished' : 'Running for'}</span><span className="v">{job.finished_at ? when(job.finished_at) : job.started_at ? since(job.started_at, now) : '—'}</span></div>
            {job.started_at && job.finished_at && <div className="kv"><span className="k">Took</span><span className="v mono">{took(job)}</span></div>}
            <div className="kv"><span className="k">Attempts</span><span className="v">{tries.length} of {job.max_attempts}</span></div>
            {job.claimed_by && live && <div className="kv"><span className="k">Worker</span><span className="v mono" style={{ fontSize: 'var(--fs-xs)' }}>{job.claimed_by}</span></div>}
            {p.loudnorm && <div className="kv"><span className="k">Loudness</span><span className="v">EBU R128</span></div>}
            {p.segmentSeconds && <div className="kv"><span className="k">Segments</span><span className="v">{p.segmentSeconds} s</span></div>}
            <div className="kv"><span className="k">Job id</span><span className="v mono" style={{ fontSize: 'var(--fs-xs)' }}>{job.id}</span></div>
          </div>
          <Attempts attempts={tries} />
        </div>
      </div>
    </div>
  )
}

function Outputs({ o }: { o: EncodeOutputs }) {
  const sp = o.sprites, th = o.thumbnails
  return (
    <>
      <table className="ej-outs">
        <thead><tr><th>Output</th><th>Details</th><th>Segments</th><th>Size</th><th>State</th></tr></thead>
        <tbody>
          {o.renditions.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--faint)' }}>No renditions yet. They appear here as the encoder writes them.</td></tr>}
          {o.renditions.map(r => (
            <tr key={r.name}>
              <td className="nm">{r.name === 'audio' ? 'Audio' : r.name}</td>
              <td style={{ color: 'var(--muted)' }}>{[r.width && r.height ? `${r.width}x${r.height}` : null, r.bitrateKbps ? `${r.bitrateKbps} kb/s` : null, r.codec].filter(Boolean).join(' · ') || '—'}</td>
              <td className="mono">{r.segments || '—'}{r.init ? '' : r.segments ? ' (no init)' : ''}</td>
              <td className="mono">{r.bytes ? fmtBytes(r.bytes) : '—'}</td>
              <td><OutState s={r.state} /></td>
            </tr>
          ))}
          {o.manifests.map(m => (
            <tr key={m.name}><td className="nm">{m.name}</td><td style={{ color: 'var(--muted)' }}>{m.state === 'ok' ? (o.asset.store === 's3' ? 'on the origin bucket' : 'packaged') : '—'}</td><td /><td /><td><OutState s={m.state} /></td></tr>
          ))}
          <tr>
            <td className="nm">Thumbnails</td>
            <td style={{ color: th.error ? '#fca5a5' : 'var(--muted)' }}>{th.error ? th.error
              : [th.count ? `${th.count} candidate stills` : null, th.chosen ? `image chosen${th.source ? ` (${th.source})` : ''}` : th.count ? 'image not chosen yet' : null].filter(Boolean).join(' · ') || '—'}</td>
            <td className="mono">{th.count || '—'}</td><td /><td><OutState s={th.state} /></td>
          </tr>
          <tr>
            <td className="nm">Sprite sheets</td>
            <td style={{ color: sp.error ? '#fca5a5' : 'var(--muted)' }}>{sp.error ? sp.error
              : sp.sheets ? `${sp.previews} hover previews${sp.intervalMs ? `, one every ${sp.intervalMs / 1000} s` : ''}` : sp.detail || '—'}</td>
            <td className="mono">{sp.sheets || '—'}</td><td /><td><OutState s={sp.state} /></td>
          </tr>
        </tbody>
      </table>
      {o.followOn.length > 0 && (
        <>
          <div className="sec-label" style={{ marginTop: 18 }}>Queued after the encode</div>
          <div className="ej-follow">
            {o.followOn.map(f => (
              <div key={f.id} className="row">
                <span className="lb">{f.label}{f.error ? <span className="ej-err" style={{ display: 'block' }} title={f.error}>{f.error}</span> : f.note && f.state === 'running' ? <span className="ej-sub" style={{ display: 'block' }}>{f.note}</span> : null}</span>
                {f.state === 'running' && <span className="mono" style={{ color: 'var(--muted)' }}>{f.progressPct}%</span>}
                <JobTag state={f.state} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function Attempts({ attempts }: { attempts: { attempt: number; claimed_by: string | null; started_at: string | null; finished_at: string | null; outcome: string | null; error: string | null }[] }) {
  if (!attempts.length) return null
  return (
    <div className="card ej-card">
      <div className="sec-label">Attempts</div>
      <div className="ej-follow">
        {attempts.map(a => (
          <div key={a.attempt}>
            <div className="row"><span className="lb" style={{ fontWeight: 600 }}>Attempt {a.attempt}</span>
              <span style={{ color: a.outcome === 'failed' || a.outcome === 'lease_expired' ? '#fca5a5' : 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{a.outcome ?? (a.finished_at ? '' : 'running')}</span></div>
            <div className="ej-sub">{when(a.started_at)}{a.started_at && a.finished_at ? ` · ${dur(Date.parse(a.finished_at) - Date.parse(a.started_at))}` : ''}</div>
            {a.error && <div className="ej-err" style={{ whiteSpace: 'normal' }}>{a.error}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------- THE LOG
function LogPanel({ id, live }: { id: string; live: boolean }) {
  const [lines, setLines] = useState<JobLogLine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stepsOnly, setStepsOnly] = useState(false)
  const [follow, setFollow] = useState(true)
  const last = useRef(0)
  const box = useRef<HTMLDivElement>(null)

  const pull = async () => {
    try {
      for (let i = 0; i < 10; i++) {   // catch up in pages of 1000
        const r = await api.jobLog(id, last.current)
        if (r.lines.length) { last.current = r.last; setLines(l => [...l, ...r.lines]) }
        if (r.lines.length < 1000) break
      }
    } catch { /* shown as empty */ } finally { setLoaded(true) }
  }
  useEffect(() => { last.current = 0; setLines([]); pull() /* eslint-disable-next-line */ }, [id])
  useEffect(() => { if (!live) { pull(); return } const t = setInterval(pull, 2000); return () => clearInterval(t) /* eslint-disable-next-line */ }, [live, id])
  const shown = useMemo(() => stepsOnly ? lines.filter(l => l.stream === 'step' || l.stream === 'warn' || /^FAILED:/.test(l.line)) : lines, [lines, stepsOnly])
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight }, [shown, follow])

  const text = () => lines.map(l => `${l.at} [${l.attempt}] ${l.stream.padEnd(4)} ${l.line}`).join('\n')
  const copy = () => { try { navigator.clipboard.writeText(text()) } catch { /* no clipboard */ } }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text() + '\n'], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = `encode-${id}.log`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="card ej-card">
      <div className="ej-log-tools">
        <div className="sec-label" style={{ margin: 0 }}>Encoder log</div>
        <span className="ej-sub" style={{ marginTop: 0 }}>{lines.length ? `${lines.length} lines` : ''}{live ? ' · live' : ''}</span>
        <div style={{ flex: 1 }} />
        <button className={`btn sm ${stepsOnly ? 'ghost' : 'primary'}`} onClick={() => setStepsOnly(false)}>Everything</button>
        <button className={`btn sm ${stepsOnly ? 'primary' : 'ghost'}`} onClick={() => setStepsOnly(true)}>Steps only</button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />Follow</label>
        <button className="btn ghost sm" disabled={!lines.length} onClick={copy}>Copy</button>
        <button className="btn ghost sm" disabled={!lines.length} onClick={download}>Download</button>
      </div>
      <div className="ej-log" ref={box} onScroll={e => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollow(false) }}>
        {!loaded ? <span className="ej-log-empty">Loading…</span>
          : shown.length === 0 ? <span className="ej-log-empty">{live ? 'Nothing logged yet. Lines appear here as the encoder writes them.' : 'No log was kept for this job. Jobs that ran before job logs were added have none.'}</span>
          : shown.map((l, i) => (
            <div key={l.seq}>
              {i > 0 && shown[i - 1].attempt !== l.attempt && <div className="att">attempt {l.attempt}</div>}
              <div className="l"><span className="ts">{clock(l.at)}</span>
                <span className={/^FAILED:/.test(l.line) ? 'fail' : l.stream === 'out' ? '' : l.stream}>{l.line}</span></div>
            </div>
          ))}
      </div>
    </div>
  )
}
