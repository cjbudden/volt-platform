// ============================================================================
//  THE HOUSE PREVIEW, QC, APPROVAL AND ARCHIVE OF ONE SLATE OR LOOP
//  (Loops & Fillers > item; migration 0161, services/media/fillerPreview.ts).
//
//  Christian, 11 Nov: the sprite-sheet hover was too poor to judge a loop by.
//  This plays the slate or loop as it airs: built once in the account's house
//  format by the encoder and packager the streams use, and played round and
//  round without stopping, so a join that is not seamless shows itself the way
//  a viewer would see it. The player repeats the loop inside its own playlist
//  (as playout.py splices it) and starts again at the end, so it never stops.
//  Beside it, what QC measured, each finding a click away from its place in
//  the loop, and the approval: nothing can be newly given to a channel, radio
//  station, event or FAST channel until a person approves it here.
// ============================================================================
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type FillerHouse, type FillerFinding, type FillerUser } from '../api'
import { useNotify } from '../notices'

const IC = {
  loop: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>,
  join: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M12 3v18" /><path d="M5 8l-3 4 3 4M19 8l3 4-3 4" /></svg>,
  ok: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="15" height="15" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>,
  no: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="15" height="15" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8" /><path d="M3 3v5h5" /></svg>,
  archive: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v10a2 2 0 002 2h12a2 2 0 002-2V9M10 13h4" /></svg>,
  rebuild: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden="true"><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>,
  error: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>,
  warning: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>,
  info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>,
}
const SEV_COLOUR = { error: 'var(--down)', warning: 'var(--warn)', info: 'var(--muted)' } as const
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const when = (t: string | null) => (t ? new Date(t).toLocaleString() : '')

export function ReviewTag({ state }: { state: FillerHouse['review']['state'] | undefined }) {
  if (state === 'approved') return <span className="tag live">Approved</span>
  if (state === 'rejected') return <span className="tag down">Rejected</span>
  return <span className="tag warn">Awaiting approval</span>
}
export function QcTag({ state, preview }: { state: FillerHouse['qc']['state'] | undefined; preview: FillerHouse['status'] | undefined }) {
  if (preview === 'queued' || preview === 'building') return <span className="tag sched">Building preview</span>
  if (preview === 'failed') return <span className="tag down">Preview failed</span>
  if (!state) return <span className="tag idle">No QC yet</span>
  if (state === 'pass') return <span className="tag live">QC pass</span>
  if (state === 'warnings') return <span className="tag warn">QC warnings</span>
  return <span className="tag down">QC errors</span>
}

/** The loop, as it airs, round and round, with the joins marked. */
function LoopPlayer({ house, kind, seekTo }: { house: NonNullable<FillerHouse['preview']>; kind: 'slate' | 'loop'; seekTo: { ms: number; n: number } | null }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<any>(null)
  const [levels, setLevels] = useState<{ i: number; h: number }[]>([])
  const [level, setLevel] = useState(-1)
  const [err, setErr] = useState('')
  const [t, setT] = useState(0)
  const [rounds, setRounds] = useState(0)
  const lastT = useRef(0)
  const L = house.loopSeconds
  const total = L * Math.max(1, house.repeats)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    setErr(''); setLevels([]); setLevel(-1)
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        const h = new Hls()
        hlsRef.current = h
        h.on(Hls.Events.MANIFEST_PARSED, (_e: any, d: any) => setLevels((d.levels ?? []).map((l: any, i: number) => ({ i, h: l.height }))))
        h.on(Hls.Events.ERROR, (_e: any, d: any) => { if (d.fatal) setErr(`Cannot play the house preview (${d.details || d.type})`) })
        h.loadSource(house.url); h.attachMedia(el)
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) el.src = house.url
      else setErr('HLS is not supported in this browser')
      el.play().catch(() => { /* a muted autoplay may still be refused; the controls are there */ })
    })()
    return () => { cancelled = true; try { hlsRef.current?.destroy() } catch { /* */ }; hlsRef.current = null }
  }, [house.url])
  // a finding's "Show": just before that place in the loop
  useEffect(() => {
    const el = ref.current
    if (!el || !seekTo) return
    el.currentTime = Math.max(0, seekTo.ms / 1000 - 1)
    el.play().catch(() => {})
  }, [seekTo?.n])
  const pick = (i: number) => { setLevel(i); if (hlsRef.current) hlsRef.current.currentLevel = i }
  const nextJoin = () => {
    const el = ref.current
    if (!el) return
    // the next join ahead, watched from three seconds before it
    const k = Math.min(house.repeats - 1, Math.max(1, Math.floor(el.currentTime / L) + 1))
    el.currentTime = Math.max(0, k * L - 3)
    el.play().catch(() => {})
  }
  const joins = Array.from({ length: Math.max(0, house.repeats - 1) }, (_v, i) => (i + 1) * L)
  return (
    <div>
      {/* loop: when the repeated playlist ends it starts again, and that join is the same join */}
      <video ref={ref} controls muted loop playsInline autoPlay
        onTimeUpdate={(e) => {
          const now = e.currentTarget.currentTime
          // back to the start of the playlist: the loop went round again (not a seek back)
          if (now + 0.5 < lastT.current && lastT.current > total - 1) setRounds((r) => r + house.repeats)
          lastT.current = now
          setT(now)
        }}
        style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 6, display: 'block' }} />
      {err && <div style={{ color: 'var(--down)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>{err}</div>}
      {/* WHERE THE JOINS ARE: the loop played back to back, each join marked */}
      {kind === 'loop' && (
        <div style={{ marginTop: 10 }}>
          <div aria-hidden="true" style={{ position: 'relative', height: 8, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, width: `${Math.min(100, (t / total) * 100)}%`, background: 'var(--brand)', opacity: 0.55 }} />
            {joins.map((j) => <div key={j} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(j / total) * 100}%`, width: 2, background: 'var(--warn)' }} />)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button className="btn ghost sm" onClick={nextJoin}>{IC.join}Watch the loop point</button>
            <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
              {IC.loop} Plays continuously · joins every {L.toFixed(1)} s · round {Math.floor(t / L) + 1 + rounds}
            </span>
          </div>
        </div>
      )}
      {levels.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>Rendition</span>
          <button className={`chip ${level === -1 ? 'active' : ''}`} onClick={() => pick(-1)}>Auto</button>
          {levels.map((l) => <button key={l.i} className={`chip ${level === l.i ? 'active' : ''}`} onClick={() => pick(l.i)}>{l.h}p</button>)}
        </div>
      )}
    </div>
  )
}

function Finding({ f, onShow }: { f: FillerFinding; onShow: (ms: number) => void }) {
  return (
    <li style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ color: SEV_COLOUR[f.severity], flex: 'none', marginTop: 1 }} title={f.severity}>{IC[f.severity]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{f.message}</div>
        {(f.measured || f.expected) && (
          <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 2 }}>
            {f.measured && <>Measured {f.measured}</>}{f.measured && f.expected && ' · '}{f.expected && <>expected {f.expected}</>}
          </div>
        )}
      </div>
      {f.fromMs != null && <button className="btn ghost sm" style={{ flex: 'none', alignSelf: 'flex-start' }} onClick={() => onShow(f.fromMs!)}>Show at {s1(f.fromMs)}</button>}
    </li>
  )
}

export default function LoopHouse({ id, kind, house, inUse, onChanged }: {
  id: string; kind: 'slate' | 'loop'; house: FillerHouse; inUse: number; onChanged: () => void
}) {
  const notify = useNotify()
  const [note, setNote] = useState(house.review.note ?? '')
  const [busy, setBusy] = useState('')
  const [seek, setSeek] = useState<{ ms: number; n: number } | null>(null)
  useEffect(() => { setNote(house.review.note ?? '') }, [house.review.note, house.review.state])
  const pv = house.preview
  const building = house.status === 'queued' || house.status === 'building'
  const needsNote = house.status !== 'ready' || house.qc.state === 'failed'
  const archived = house.availability.state === 'archived'

  async function act(what: string, fn: () => Promise<any>, ok: string) {
    setBusy(what)
    try { await fn(); notify({ kind: 'ok', message: ok }); onChanged() }
    catch (e: any) { notify({ kind: 'error', message: e instanceof ApiError && e.body?.message ? e.body.message : e.message }) }
    finally { setBusy('') }
  }
  const review = (decision: 'approve' | 'reject' | 'reset') => act(decision, async () => {
    const r = await api.reviewFiller(id, { decision, note: note.trim() || null })
    if (decision === 'reject' && r.usedBy?.length) {
      notify({ kind: 'info', message: `${(r.usedBy as FillerUser[]).map((u) => u.name).join(', ')} still ${r.usedBy.length === 1 ? 'uses' : 'use'} it until changed.` })
    }
  }, decision === 'approve' ? 'Approved: it can now be chosen for channels, radio, events and FAST.' : decision === 'reject' ? 'Rejected.' : 'Sent back to waiting for approval.')

  return (
    <section className="card">
      <div className="card-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>House preview</h3>
        <span className="sub">{pv ? `as viewers see it, in ${pv.house.standard ? 'the standard house format' : `the house format (${pv.house.profileName})`}` : 'as viewers will see it'}</span>
        <div className="spacer" />
        <ReviewTag state={house.review.state} />
        <QcTag state={house.qc.state} preview={house.status} />
        {archived && <span className="tag idle">Archived</span>}
      </div>
      <div className="card-b" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 460px', minWidth: 0 }}>
          {pv && house.status === 'ready'
            ? <LoopPlayer house={pv} kind={kind} seekTo={seek} />
            : <div style={{ aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', background: 'var(--panel-2)', borderRadius: 6, color: 'var(--faint)', textAlign: 'center', padding: 16 }}>
                {building ? 'Building the house preview with the same encoder the streams use. This takes about a minute.'
                  : house.status === 'failed' ? <span style={{ color: 'var(--down)' }}>The house preview could not be made: {house.error}</span>
                  : 'No house preview yet.'}
              </div>}
          {pv && (
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 10, lineHeight: 1.6 }}>
              {pv.renditions.map((r) => `${r.label} ${r.bitrateKbps} kbps`).join(', ')} · H.264 · {pv.renditions[0]?.fps} fps · AAC stereo · {pv.segmentSeconds} s segments
              {kind === 'loop' && <><br />Plays {pv.loopSeconds.toFixed(1)} s{pv.sourceMs ? ` of the ${s1(pv.sourceMs)} file` : ''}, then starts again</>}
              {!pv.house.standard && <><br />House format: the output profile {pv.house.profileName}{pv.house.usedBy ? `, used by ${pv.house.usedBy} channel${pv.house.usedBy === 1 ? '' : 's'}` : ''}. Each stream still gets its own copy for its ladder (Used by, below).</>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn ghost sm" disabled={building || !!busy} onClick={() => act('rebuild', () => api.rebuildFillerHouse(id), 'Building the house preview again.')}>{IC.rebuild}Build the preview again</button>
            {pv && <button className="btn ghost sm" disabled={building || !!busy} onClick={() => act('qc', () => api.rerunFillerQc(id), 'QC ran again.')}>Run QC again</button>}
          </div>
        </div>

        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <div className="sec-label">QC</div>
            {building && <div style={{ color: 'var(--faint)' }}>Runs once the preview is built.</div>}
            {!building && house.qc.findings.length === 0 && house.qc.state && <div style={{ color: 'var(--muted)' }}>{IC.ok} Nothing found: it plays cleanly, at the right length, with a clean join.</div>}
            {!building && house.qc.findings.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {house.qc.findings.map((f, i) => <Finding key={i} f={f} onShow={(ms) => setSeek((s) => ({ ms, n: (s?.n ?? 0) + 1 }))} />)}
              </ul>
            )}
            {house.qc.skipped.length > 0 && (
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>Not checked: {house.qc.skipped.map((x) => `${x.check.replace(/_/g, ' ')} (${x.reason})`).join('; ')}.</div>
            )}
          </div>

          <div>
            <div className="sec-label">Approval</div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
              {house.review.state === 'approved' ? `Approved${house.review.by ? ` by ${house.review.by}` : ''}${house.review.at ? `, ${when(house.review.at)}` : ''}. It can be chosen for channels, radio, events and FAST.`
                : house.review.state === 'rejected' ? `Rejected${house.review.by ? ` by ${house.review.by}` : ''}${house.review.at ? `, ${when(house.review.at)}` : ''}. It cannot be chosen.`
                : 'Waiting for a person to watch the preview and approve it. Until then it cannot be chosen for anything.'}
            </div>
            <textarea className="inp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', resize: 'vertical' }}
              placeholder={needsNote ? 'Note (needed to approve: QC found errors or there is no preview)' : 'Note (optional): why it was approved or rejected'} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {house.review.state !== 'approved' && (
                <button className="btn primary sm" disabled={!!busy || building || (needsNote && !note.trim())} onClick={() => review('approve')}
                  title={needsNote && !note.trim() ? 'Add a note saying why it is approved anyway' : undefined}>{IC.ok}Approve</button>
              )}
              {house.review.state !== 'rejected' && <button className="btn ghost sm" disabled={!!busy} onClick={() => review('reject')}>{IC.no}Reject</button>}
              {house.review.state !== 'pending' && <button className="btn ghost sm" disabled={!!busy} onClick={() => review('reset')}>{IC.back}Back to waiting</button>}
            </div>
          </div>

          <div>
            <div className="sec-label">Availability</div>
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
              {archived ? `Archived${house.availability.by ? ` by ${house.availability.by}` : ''}${house.availability.at ? `, ${when(house.availability.at)}` : ''}: kept, but off every picker.`
                : inUse ? `Available, and in use by ${inUse} stream${inUse === 1 ? '' : 's'}: it cannot be archived until they use something else.`
                : 'Available. Archive it to keep it but take it off every picker.'}
            </div>
            {archived
              ? <button className="btn ghost sm" disabled={!!busy} onClick={() => act('avail', () => api.setFillerAvailability(id, 'available'), 'Available again.')}>{IC.back}Make available</button>
              : <button className="btn ghost sm" disabled={!!busy || inUse > 0} onClick={() => act('avail', () => api.setFillerAvailability(id, 'archived'), 'Archived.')}>{IC.archive}Archive</button>}
          </div>
        </div>
      </div>
    </section>
  )
}
