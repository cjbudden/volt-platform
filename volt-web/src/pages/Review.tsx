import { useEffect, useState } from 'react'
import { api, type ReviewQueueRow, type AssetReview, type QcFinding } from '../api'
import { navigate } from '../router'
import { Notice, PageError, usePageNotice } from '../notices'
import { useAccess } from '../access'

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

// The server asks for a reason on every move but these two (modules/vod.ts,
// POST /:id/review). Said up front and checked here, so a reviewer is not
// sent to the server to find out.
const NEEDS_NOTE: AssetReview['state'][] = ['changes_requested', 'rejected', 'draft']

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

export function ReviewPanel({ assetId, onDecided }: { assetId: string; onDecided: () => void }) {
  const [r, setR] = useState<AssetReview | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState('')
  // Deciding and re-running QC are writes on the Media library feature
  // (auth/roles.ts: manage), so a View role sees the evidence without
  // buttons the server would refuse.
  const { can } = useAccess()
  const canDecide = can('vod', 'manage')

  async function load() {
    try { setR(await api.assetReview(assetId)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [assetId])

  // Only when there is nothing to show. `err` is also written by the actions
  // on this page, so an unconditional guard let one rejected action replace
  // the working page — including the controls needed to retry — with a line
  // of red text and no way back except navigating away.
  if (err && !r) return <Notice kind="error" variant="compact" title="Couldn't load this review." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />
  if (!r) return <div className="loading">Loading…</div>

  async function move(to: AssetReview['state']) {
    if (NEEDS_NOTE.includes(to) && !note.trim()) {
      setInfo('')
      setErr(to === 'rejected' ? 'Add a note saying why before rejecting.' : 'Add a note saying what needs to change first.')
      return
    }
    setBusy(to); setErr(''); setInfo('')
    try {
      await api.decideReview(assetId, to, note.trim() || undefined)
      setNote(''); await load(); onDecided()
    } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  // A refused or failed start used to vanish (try/finally, no catch), so the
  // button looked as if it did nothing. Now it says either way.
  async function rerunQc() {
    setBusy('qc'); setErr(''); setInfo('')
    try {
      await api.rerunQc(assetId)
      setInfo('QC is running again. The findings below update in a few seconds.')
      setTimeout(load, 3000)
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
        {canDecide && (
          <button className="btn ghost" disabled={!!busy} onClick={rerunQc}>
            {busy === 'qc' ? 'Starting QC…' : 'Re-run QC'}
          </button>
        )}
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
      {!canDecide ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 10 }}>
          Your role can see this review but not decide it.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 6 }}>
            <input value={note} onChange={e => { setNote(e.target.value); if (err) setErr('') }}
              aria-label="Note"
              placeholder="A note for whoever reads this next…" style={{ flex: 1, minWidth: 240 }} />
            {/* WHAT MAY FOLLOW WHAT is the server's (services/review.ts LEGAL).
                Changes requested goes back into review before it can be
                approved, so it is offered Send back for review, not Approve. */}
            {(r.state === 'draft' || r.state === 'rejected') && (
              <button className="btn primary" disabled={!!busy} onClick={() => move('in_review')}>
                Send for review
              </button>
            )}
            {r.state === 'in_review' && (
              <>
                <button className="btn primary" disabled={!!busy} onClick={() => move('approved')}>
                  {r.gate.wouldOverride ? 'Approve anyway' : 'Approve'}
                </button>
                <button className="btn ghost" disabled={!!busy} onClick={() => move('changes_requested')}>
                  Request changes
                </button>
              </>
            )}
            {(r.state === 'changes_requested' || r.state === 'approved') && (
              <button className="btn primary" disabled={!!busy} onClick={() => move('in_review')}>
                Send back for review
              </button>
            )}
            {r.state !== 'rejected' && (
              <button className="btn ghost" disabled={!!busy} onClick={() => move('rejected')}>Reject</button>
            )}
          </div>
          <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)', marginBottom: 10 }}>
            {r.state === 'changes_requested'
              ? 'Send it back for review once the changes are made; it can be approved from there. A note is needed to reject.'
              : 'A note is needed to request changes or reject.'}
          </div>
        </>
      )}
      {r.gate.wouldOverride && canDecide && r.state === 'in_review' && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--warn,#fbbf24)', marginBottom: 10 }}>
          Approving with QC findings outstanding is allowed, and it is recorded against your name.
        </div>
      )}
      {info && <div style={{ marginBottom: 10 }}><Notice kind="info" variant="compact" message={info} /></div>}
      {err && <div style={{ marginBottom: 10 }}><Notice kind="error" variant="compact" message={err} /></div>}

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
  // ?open=<asset id>: the Media Library's "Open in Review" lands on that clip.
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('open'))

  async function load() {
    try { const q = await api.reviewQueue(); setRows(q.queue); setErr('') }
    catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  usePageNotice('load', err && rows ? { kind: 'error', title: "Couldn't load the review queue.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (err && !rows) return <PageError message={err} onRetry={load} />
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

      {rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing waiting</h3>
          <p>Clips appear here when they are sent for review: open a clip in the
             Media Library and choose Send for review beside its Review state.
             QC runs on every clip as it is cut, so they arrive with their
             findings already attached.</p>
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
