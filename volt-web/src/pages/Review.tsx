import { useEffect, useState } from 'react'
import { api, type ReviewQueueRow, type AssetReview, type QcFinding } from '../api'
import { navigate } from '../router'

/* ============================================================================
   REVIEW — clips waiting for somebody, and what a machine already found.

   Two things are on this page and they are deliberately not the same thing.

   QC is what was MEASURED: silence, black frames, a duration that does not match
   what was asked for, a source range with holes in it. Findings, with a time you
   can jump to and a measurement you can judge.

   REVIEW is what somebody DECIDED, with their name and a note attached.

   Keeping them apart is the point. A machine that decides is a machine people
   route around; a person deciding with nothing measured is a person guessing.
   The gate between them is soft: publishing over a warning is allowed, and it is
   written down, which is what makes the warning worth reading.
   ========================================================================== */

const SEV_TONE: Record<string, string> = {
  error: 'var(--danger,#f87171)',
  warning: 'var(--warn,#fbbf24)',
  info: 'var(--faint)',
}

const STATE_TONE: Record<string, string> = {
  approved: 'var(--ok,#4ade80)',
  rejected: 'var(--danger,#f87171)',
  changes_requested: 'var(--warn,#fbbf24)',
  in_review: 'var(--brand,#3f7bff)',
  draft: 'var(--faint)',
}

const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
}

const QC_TONE: Record<string, string> = {
  pass: 'var(--ok,#4ade80)',
  warnings: 'var(--warn,#fbbf24)',
  failed: 'var(--danger,#f87171)',
}

function fmtDur(ms: number | string | null | undefined) {
  const s = Math.round(Number(ms ?? 0) / 1000)
  if (!s) return '—'
  const m = Math.floor(s / 60)
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}
function fmtAt(ms: number | null | undefined) {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Finding({ f }: { f: QcFinding }) {
  const at = fmtAt(f.from_ms)
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'baseline',
      padding: '6px 0', borderTop: '1px solid var(--border)',
    }}>
      <span style={{
        fontSize: 'var(--fs-micro)', textTransform: 'uppercase',
        letterSpacing: 'var(--ls-label)', color: SEV_TONE[f.severity], width: 62, flex: 'none',
      }}>{f.severity}</span>
      <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', width: 60, flex: 'none' }}>
        {f.check_name}
      </span>
      {at && (
        <span style={{
          fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)',
          color: 'var(--brand)', width: 54, flex: 'none',
        }}>{at}</span>
      )}
      <span style={{ fontSize: 'var(--fs-sm)', flex: 1 }}>
        {f.message}
        {f.measured && (
          <span style={{ color: 'var(--faint)' }}>
            {' '}({f.measured}{f.expected ? `, expected ${f.expected}` : ''})
          </span>
        )}
      </span>
    </div>
  )
}

function ReviewPanel({ assetId, onDecided }: { assetId: string; onDecided: () => void }) {
  const [r, setR] = useState<AssetReview | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')

  async function load() {
    try { setR(await api.assetReview(assetId)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [assetId])

  if (err) return <div className="err">{err}</div>
  if (!r) return <div className="loading">Loading…</div>

  async function move(to: AssetReview['state']) {
    setBusy(to); setErr('')
    try {
      await api.decideReview(assetId, to, note.trim() || undefined)
      setNote(''); await load(); onDecided()
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  const findings = r.qc.findings.filter(f => !f.message.startsWith('Not checked'))
  const notChecked = r.qc.findings.filter(f => f.message.startsWith('Not checked'))

  return (
    <div style={{ padding: '6px 2px 14px' }}>
      <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 10 }}>
        <span style={{ color: STATE_TONE[r.state], fontSize: 'var(--fs-sm)' }}>
          {STATE_LABEL[r.state] ?? r.state}
        </span>
        {r.qc.state && (
          <span style={{ color: QC_TONE[r.qc.state], fontSize: 'var(--fs-sm)' }}>
            QC {r.qc.state}
          </span>
        )}
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{r.gate.message}</span>
        <div className="flex-1" />
        <button className="btn ghost" disabled={!!busy}
          onClick={async () => { setBusy('qc'); try { await api.rerunQc(assetId); setTimeout(load, 3000) } finally { setBusy('') } }}>
          Re-run QC
        </button>
      </div>

      <div className="sec-label">What was measured</div>
      {findings.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', padding: '4px 0 8px' }}>
          {r.qc.state === 'pass'
            ? 'Every check ran and found nothing.'
            : 'Nothing measured yet. Run QC to see what is in this clip.'}
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>{findings.map((f, i) => <Finding key={i} f={f} />)}</div>
      )}
      {notChecked.length > 0 && (
        <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)', marginBottom: 10 }}>
          {/* Said out loud rather than left as an absence: "we did not look" and
              "we looked and it was fine" are different answers. */}
          Not checked: {notChecked.map(f => f.check_name).join(', ')}.
        </div>
      )}

      <div className="sec-label">Decide</div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 10 }}>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="A note for whoever reads this next…" style={{ flex: 1, minWidth: 240 }} />
        {r.state === 'draft' && (
          <button className="btn primary" disabled={!!busy} onClick={() => move('in_review')}>
            Send for review
          </button>
        )}
        {(r.state === 'in_review' || r.state === 'changes_requested') && (
          <>
            <button className="btn primary" disabled={!!busy} onClick={() => move('approved')}>
              {r.gate.wouldOverride ? 'Approve anyway' : 'Approve'}
            </button>
            {r.state === 'in_review' && (
              <button className="btn ghost" disabled={!!busy} onClick={() => move('changes_requested')}>
                Request changes
              </button>
            )}
            <button className="btn ghost" disabled={!!busy} onClick={() => move('rejected')}>Reject</button>
          </>
        )}
        {r.state === 'approved' && (
          <button className="btn ghost" disabled={!!busy} onClick={() => move('in_review')}>
            Send back for review
          </button>
        )}
      </div>
      {r.gate.wouldOverride && (r.state === 'in_review' || r.state === 'changes_requested') && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginBottom: 10 }}>
          Approving with QC findings outstanding is allowed, and it is recorded against your name.
        </div>
      )}
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}

      {r.history.length > 0 && (
        <>
          <div className="sec-label">Who decided what</div>
          <table>
            <thead><tr><th style={{ width: 180 }}>When</th><th>Who</th><th>Decision</th><th>Note</th></tr></thead>
            <tbody>
              {r.history.map((h, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(h.at).toLocaleString()}</td>
                  <td>{h.actor_label}</td>
                  <td style={{ color: STATE_TONE[h.to_state] }}>
                    {STATE_LABEL[h.to_state] ?? h.to_state}
                    {h.overrode_qc && (
                      <span style={{ color: 'var(--warn,#fbbf24)', fontSize: 'var(--fs-micro)' }}>
                        {' '}· over QC {h.qc_state_at_decision}
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{h.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export default function ReviewPage() {
  const [rows, setRows] = useState<ReviewQueueRow[] | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  async function load() {
    try { const q = await api.reviewQueue(); setRows(q.queue); setErr('') }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  if (err && !rows) return <div className="err">{err}</div>
  if (!rows) return <div className="loading">Loading the queue…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review</h1>
          <p>Clips waiting for a decision, with what QC already found in them.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div className="err">{err}</div>}

      {rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing waiting</h3>
          <p>Clips appear here when they are sent for review. QC runs on every clip
             as it is cut, so they arrive with their findings already attached.</p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Clip</th><th>Source</th><th>Length</th><th>QC</th><th>State</th><th>Cut</th><th /></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <FragmentRow key={r.id} r={r} open={open === r.id}
                  onToggle={() => setOpen(open === r.id ? null : r.id)}
                  onDecided={load} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function FragmentRow({ r, open, onToggle, onDecided }: {
  r: ReviewQueueRow; open: boolean; onToggle: () => void; onDecided: () => void
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td><b>{r.title || 'Untitled clip'}</b></td>
        <td style={{ color: 'var(--muted)' }}>{r.source_name ?? '—'}</td>
        <td style={{ color: 'var(--muted)' }}>{fmtDur(r.duration_ms)}</td>
        <td>
          {r.qc_state
            ? <span style={{ color: QC_TONE[r.qc_state], fontSize: 'var(--fs-sm)' }}>
                {r.qc_state}
                {(r.qc_errors > 0 || r.qc_warnings > 0) && (
                  <span style={{ color: 'var(--faint)' }}>
                    {' '}({r.qc_errors} error{r.qc_errors === 1 ? '' : 's'}, {r.qc_warnings} warning{r.qc_warnings === 1 ? '' : 's'})
                  </span>
                )}
              </span>
            : <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>not run</span>}
        </td>
        <td style={{ color: STATE_TONE[r.review_state], fontSize: 'var(--fs-sm)' }}>
          {STATE_LABEL[r.review_state] ?? r.review_state}
        </td>
        <td style={{ color: 'var(--muted)' }}>{new Date(r.created_at).toLocaleString()}</td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button className="btn ghost" onClick={e => { e.stopPropagation(); onToggle() }}>
            {open ? 'Close' : 'Open'}
          </button>
          {r.recording_id && (
            <button className="btn ghost" style={{ marginLeft: 6 }}
              onClick={e => { e.stopPropagation(); navigate(`/recordings/${r.recording_id}`) }}>
              Source
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={7} style={{ background: 'var(--panel-2)' }}>
          <ReviewPanel assetId={r.id} onDecided={onDecided} />
        </td></tr>
      )}
    </>
  )
}
