// ============================================================================
//  CAN THIS ASSET BE USED: the usage status, on the card, in the table, and at
//  the top of the asset panel with the reason and what to do about it.
//
//  The status is decided on the server (volt-app services/assetReadiness.ts):
//    ready       media built and confirmed playable by QC (or approved)
//    unchecked   media built, QC has not run yet
//    qc_failed   plays, but QC found an error (a gap, wrong length)
//    processing  a build or encode is running
//    failed      the build or encode failed
//    unplayable  files exist but will not decode
//    no_media    nothing was built and nothing is coming
//  Only `ready` is offered to FAST, loops and blocking.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, ApiError, type QcFinding, type UsageStatus } from '../../api'
import { useNotify } from '../../notices'
import { navigate } from '../../router'
import { LibIcon } from './icons'
import type { LibraryRow } from './libraryApi'

export const USAGE_LABEL: Record<UsageStatus, string> = {
  ready: 'Ready', unchecked: 'Not checked', qc_failed: 'QC failed', processing: 'Building',
  failed: 'Build failed', unplayable: 'Will not play', no_media: 'No media',
}
export const USAGE_TIP: Record<UsageStatus, string> = {
  ready: 'Media built and confirmed playable. Can be used in FAST, loops and blocking.',
  unchecked: 'Media built, QC has not checked it yet. Not offered for scheduling until it has.',
  qc_failed: 'Plays, but QC found an error. Check each finding in the player and accept it if it is fine, or fix it.',
  processing: 'The media is being built.',
  failed: 'The build failed, so there is nothing to play.',
  unplayable: 'Files exist but QC could not decode them.',
  no_media: 'Nothing was built for this asset and nothing is coming.',
}
const TONE: Record<UsageStatus, string> = {
  ready: 'live', unchecked: 'idle', qc_failed: 'warn', processing: 'sched', failed: 'down', unplayable: 'down', no_media: 'down',
}
export const isProblem = (s: UsageStatus | undefined) => s === 'failed' || s === 'unplayable' || s === 'no_media' || s === 'qc_failed'
/** No media to describe: the encode summary must not claim renditions that were never made. */
export const hasNoMedia = (s: UsageStatus | undefined) => s === 'failed' || s === 'unplayable' || s === 'no_media'

/** A status pill. `quiet` hides it when the asset is ready (cards stay clean). */
export function UsageBadge({ row, quiet, overlay }: { row: Pick<LibraryRow, 'usage_status' | 'media_error'>; quiet?: boolean; overlay?: boolean }) {
  const s = row.usage_status
  if (!s || (quiet && s === 'ready')) return null
  const icon = s === 'ready' ? LibIcon.check : s === 'processing' ? LibIcon.clock : s === 'unchecked' ? LibIcon.empty : LibIcon.alert
  const tip = row.media_error && hasNoMedia(s) ? `${USAGE_TIP[s]} ${row.media_error}` : USAGE_TIP[s]
  if (overlay) return <span className={`lib-badge lib-badge-status st-${TONE[s]}`} title={tip}>{icon}{USAGE_LABEL[s]}</span>
  return <span className={`tag ${TONE[s]} lib-pill lib-usage`} title={tip}><span className="lib-dot" aria-hidden="true" />{USAGE_LABEL[s]}</span>
}

const fmtS = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`

/**
 * The asset panel's answer to "why will this not play, and what now". Shown
 * in place of the player whenever there is no media to play, and above the
 * facts when QC found something.
 */
export function AssetStatusPanel({ asset, onChanged }: { asset: any; onChanged: () => void }) {
  const notify = useNotify()
  const [busy, setBusy] = useState('')
  const [gap, setGap] = useState<{ gapMs: number; coveragePct: number; message: string } | null>(null)
  const s: UsageStatus | undefined = asset.usage_status
  if (!s || s === 'ready') return null
  const isClip = asset.source_kind === 'recording' && asset.kind === 'clip'
  const isUpload = asset.source_kind === 'upload' || asset.source_kind === 'watchfolder'

  async function rebuild(acceptGapsMs = 0) {
    setBusy('rebuild')
    try {
      await api.vodRebuild(asset.id, acceptGapsMs)
      setGap(null)
      notify({ kind: 'ok', message: 'Building again. The status updates here when it finishes, and QC runs after it.' })
      onChanged()
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409 && e.body) setGap({ gapMs: Number(e.body.gapMs ?? 0), coveragePct: Number(e.body.coveragePct ?? 0), message: e.body.error ?? e.message })
      else notify({ kind: 'error', message: e.message })
    } finally { setBusy('') }
  }
  async function retryEncode() {
    if (!asset.encode_job_id) return
    setBusy('encode')
    try { await api.retryJob(asset.encode_job_id); notify({ kind: 'ok', message: 'Encoding again.' }); onChanged() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  async function qc() {
    setBusy('qc')
    try { await api.rerunQc(asset.id); notify({ kind: 'ok', message: 'QC is running. The result shows here when it finishes.' }); onChanged() }
    catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  const reason = s === 'failed' ? (asset.media_error ?? asset.encode_error ?? 'The build failed.')
    : s === 'unplayable' ? (asset.media_error ?? 'QC could not decode the media.')
    : s === 'no_media' ? (asset.media_error ?? 'Nothing was built for this asset.')
    : s === 'qc_failed' ? 'QC found an error in this media. It plays, but is held back from FAST, loops and blocking. Check each finding below in the player: once every error is accepted as fine, it is released.'
    : s === 'unchecked' ? 'QC has not checked this media yet, so it is not offered for scheduling.'
    : 'The media is being built.'

  return (
    <div className={`asset-status st-${TONE[s]}`} role={hasNoMedia(s) ? 'alert' : 'status'} data-usage={s}>
      <div className="asset-status-h">
        <span className="asset-status-ic" aria-hidden="true">{s === 'processing' ? LibIcon.clock : s === 'unchecked' ? LibIcon.info : LibIcon.alert}</span>
        <div>
          <div className="asset-status-t">{USAGE_LABEL[s]}{hasNoMedia(s) ? ': this asset cannot be played' : ''}</div>
          <div className="asset-status-m">{reason}</div>
        </div>
      </div>
      {gap && (
        <div className="asset-status-m asset-status-gap">
          {gap.message} Accepting the gap builds the clip with {fmtS(gap.gapMs)} missing ({gap.coveragePct}% covered); QC will flag the jump.
        </div>
      )}
      <div className="asset-status-a">
        {isClip && (s === 'failed' || s === 'no_media' || s === 'unplayable') && !gap && (
          <button className="btn primary sm" disabled={!!busy} onClick={() => rebuild(0)}>{busy === 'rebuild' ? 'Starting…' : 'Build again'}</button>
        )}
        {isClip && gap && (
          <button className="btn primary sm" disabled={!!busy} onClick={() => rebuild(Math.min(600_000, Math.ceil((gap.gapMs + 1000) / 1000) * 1000))}>
            {busy === 'rebuild' ? 'Starting…' : `Build, accepting ${fmtS(gap.gapMs)} of gaps`}
          </button>
        )}
        {isUpload && s === 'failed' && asset.encode_job_id && (
          <button className="btn primary sm" disabled={!!busy} onClick={retryEncode}>{busy === 'encode' ? 'Starting…' : 'Encode again'}</button>
        )}
        {s !== 'processing' && s !== 'no_media' && s !== 'failed' && (
          <button className="btn ghost sm" disabled={!!busy} onClick={qc}>{busy === 'qc' ? 'Queued…' : s === 'unchecked' ? 'Run QC now' : 'Run QC again'}</button>
        )}
        {asset.recording_id && hasNoMedia(s) && <button className="btn ghost sm" onClick={() => navigate(`/recordings/${asset.recording_id}`)}>Open the recording</button>}
      </div>
    </div>
  )
}

const CHECK_LABEL: Record<string, string> = {
  media: 'Media', playback: 'Playback', duration: 'Length', coverage: 'Coverage', silence: 'Silence', black: 'Black', loudness: 'Loudness',
}
const ALL_CHECKS = ['media', 'playback', 'duration', 'coverage', 'silence', 'black', 'loudness']

/** m:ss.s, the precision a reviewer needs to land on a finding. */
const fmtAt = (ms: number) => { const s = Math.max(0, ms) / 1000; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}` }
const PREROLL_MS = 2000
const POSTROLL_MS = 1000

/**
 * QC REVIEW: what QC looked at, every finding it made, and a person's verdict
 * on each one.
 *
 * QC says what it measured; whether that matters is a judgement, and the
 * judgement needs the media. Every finding with a place in the clip can be
 * jumped to (the player pauses on it) or played (two seconds before to a
 * second after, then it stops). Then it is marked "Looks fine" or "Real
 * problem". Accepted findings stop counting: when every error is accepted
 * the asset is no longer held back, and the panel says QC itself failed it so
 * the override stays visible. Accepting an error needs a note.
 */
export function QcChecks({ id, state, at, durationMs, onJump, onChanged }: {
  id: string; state: string | null; at: string | null
  /** The clip's length, for the strip of where findings are. */
  durationMs?: number | null
  /** Seek the asset's player. Without it, places are shown but not clickable. */
  onJump?: (r: { ms: number; play?: boolean; untilMs?: number | null }) => void
  /** A verdict changed the asset's QC state. */
  onChanged?: () => void
}) {
  const notify = useNotify()
  const [findings, setFindings] = useState<QcFinding[] | null>(null)
  const [machine, setMachine] = useState<string | null>(null)
  const [current, setCurrent] = useState<number | null>(null)
  const [noteFor, setNoteFor] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  useEffect(() => { let gone = false; api.assetReview(id).then((r) => { if (!gone) { setFindings(r.qc.findings); setMachine(r.qc.machineState ?? r.qc.state) } }).catch(() => { if (!gone) setFindings([]) }); return () => { gone = true } }, [id, state, at])
  if (!state || !findings) return null

  const notRun = (f: QcFinding) => f.severity === 'info' && /^Not checked:/.test(f.message)
  const real = findings.filter((f) => !notRun(f))
  const reviewable = real.filter((f) => f.id != null && f.severity !== 'info')
  const open = reviewable.filter((f) => !f.review_state)
  const located = real.filter((f) => f.from_ms != null)
  const ordered = [...located].sort((a, b) => Number(a.from_ms) - Number(b.from_ms))
  const span = Math.max(Number(durationMs ?? 0), ...located.map((f) => Number(f.to_ms ?? f.from_ms ?? 0)), 1)

  const go = (f: QcFinding, play = false) => {
    if (f.from_ms == null || !onJump) return
    setCurrent(f.id ?? null)
    const from = Number(f.from_ms), to = Number(f.to_ms ?? f.from_ms)
    onJump(play ? { ms: Math.max(0, from - PREROLL_MS), play: true, untilMs: to + POSTROLL_MS } : { ms: from })
  }
  const nextOpen = () => {
    const after = current == null ? -1 : Number(ordered.find((f) => f.id === current)?.from_ms ?? -1)
    const list = ordered.filter((f) => f.id != null && f.severity !== 'info' && !f.review_state)
    const n = list.find((f) => Number(f.from_ms) > after) ?? list[0]
    if (n) go(n)
  }
  async function verdict(f: QcFinding, v: 'accepted' | 'confirmed' | null, withNote?: string) {
    if (f.id == null) return
    if (v === 'accepted' && f.severity === 'error' && !withNote?.trim()) { setNoteFor(f.id); setNote(''); return }
    setBusy(f.id)
    try {
      const r = await api.reviewQcFinding(id, f.id, v, withNote?.trim() || undefined)
      setFindings((fs) => fs?.map((x) => (x.id === f.id ? r.qc.finding : x)) ?? fs)
      setMachine(r.qc.machineState)
      setNoteFor(null); setNote('')
      if (r.qc.state !== state) onChanged?.()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(null) }
  }

  const overridden = machine === 'failed' && state !== 'failed'
  const summary = open.length
    ? `${open.length} finding${open.length === 1 ? '' : 's'} to check${open.some((f) => f.severity === 'error') ? `, ${open.filter((f) => f.severity === 'error').length} blocking` : ''}.`
    : reviewable.length ? `Every finding has been checked.` : null

  // Checks with nothing to say still get a line: clean, or not run and why.
  const quiet = ALL_CHECKS.map((c) => ({ c, fs: real.filter((f) => f.check_name === c), skip: findings.find((f) => f.check_name === c && notRun(f)) }))
    .filter((r) => !r.fs.length && (r.skip || r.c === 'media' || r.c === 'playback' || r.c === 'duration'))

  return (
    <div className="qc-review" aria-label="QC review">
      {(summary || overridden) && (
        <div className="qc-review-sum">
          {overridden && <div><b>Passes after review.</b> QC failed it; every error was checked and accepted.</div>}
          {summary && <div>{summary}</div>}
          {open.some((f) => f.from_ms != null) && onJump && <button type="button" className="btn ghost sm" onClick={nextOpen}>Go to next</button>}
        </div>
      )}
      {located.length > 0 && (
        <div className="qc-strip" role="group" aria-label="Where QC found things">
          {located.map((f, i) => {
            const a = Number(f.from_ms), b = Math.max(a, Number(f.to_ms ?? a))
            const tone = f.review_state === 'accepted' ? 'done' : f.review_state === 'confirmed' ? 'bad' : f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'
            return <button key={f.id ?? i} type="button" className={`qc-strip-m ${tone}${current === f.id ? ' on' : ''}`}
              style={{ left: `${(a / span) * 100}%`, width: `max(4px, ${((b - a) / span) * 100}%)` }}
              title={`${CHECK_LABEL[f.check_name] ?? f.check_name} at ${fmtAt(a)}: ${f.message}`} aria-label={`Go to ${CHECK_LABEL[f.check_name] ?? f.check_name} at ${fmtAt(a)}`}
              disabled={!onJump} onClick={() => go(f)} />
          })}
        </div>
      )}
      <ul className="qc-checks" aria-label="QC checks">
        {quiet.map(({ c, skip }) => (
          <li key={c} className={`qc-check ${skip ? 'skip' : 'ok'}`}>
            <span className="qc-check-ic" aria-hidden="true">{skip ? LibIcon.empty : LibIcon.check}</span>
            <span className="qc-check-n">{CHECK_LABEL[c] ?? c}</span>
            <span className="qc-check-m">{skip ? skip.message : 'OK'}</span>
          </li>
        ))}
        {[...real].sort((a, b) => (ALL_CHECKS.indexOf(a.check_name) - ALL_CHECKS.indexOf(b.check_name)) || (Number(a.from_ms ?? -1) - Number(b.from_ms ?? -1))).map((f, i) => {
          const tone = f.review_state === 'accepted' ? 'done' : f.severity === 'error' || f.review_state === 'confirmed' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'
          const reviewableRow = f.id != null && f.severity !== 'info'
          return (
            <li key={f.id ?? `${f.check_name}-${i}`} className={`qc-check qc-finding ${tone}${current != null && current === f.id ? ' on' : ''}`}>
              <span className="qc-check-ic" aria-hidden="true">{f.review_state === 'accepted' ? LibIcon.check : tone === 'info' ? LibIcon.info : LibIcon.alert}</span>
              <span className="qc-check-n">{CHECK_LABEL[f.check_name] ?? f.check_name}</span>
              <span className="qc-check-m">
                {f.message}
                {(f.measured || f.expected) && <span className="qc-meas">{f.measured ? `Measured ${f.measured}` : ''}{f.expected ? ` · expected ${f.expected}` : ''}</span>}
                {f.from_ms != null && (
                  <span className="qc-at">
                    <button type="button" className="qc-at-t" disabled={!onJump} onClick={() => go(f)} title="Go to this point, paused">
                      {fmtAt(Number(f.from_ms))}{f.to_ms != null && Number(f.to_ms) !== Number(f.from_ms) ? `–${fmtAt(Number(f.to_ms))}` : ''}
                    </button>
                    <button type="button" className="qc-at-p" disabled={!onJump} onClick={() => go(f, true)} title="Play from 2 s before to 1 s after, then stop">
                      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>Play
                    </button>
                  </span>
                )}
                {reviewableRow && f.review_state && (
                  <span className="qc-verdict">
                    {f.review_state === 'accepted' ? 'Checked, looks fine' : 'Checked, real problem'}{f.reviewed_by ? ` · ${f.reviewed_by}` : ''}
                    {f.review_note ? <span className="qc-verdict-n">“{f.review_note}”</span> : null}
                    <button type="button" className="qc-undo" disabled={busy === f.id} onClick={() => verdict(f, null)}>Undo</button>
                  </span>
                )}
                {reviewableRow && !f.review_state && noteFor !== f.id && (
                  <span className="qc-acts">
                    <button type="button" className="btn ghost sm" disabled={busy === f.id} onClick={() => verdict(f, 'accepted')}>Looks fine</button>
                    <button type="button" className="btn ghost sm" disabled={busy === f.id} onClick={() => verdict(f, 'confirmed')}>Real problem</button>
                  </span>
                )}
                {noteFor === f.id && (
                  <span className="qc-note">
                    <input className="inp" autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                      placeholder="Why it is fine, e.g. the end is the credits" aria-label="Why this error is fine"
                      onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) verdict(f, 'accepted', note); if (e.key === 'Escape') setNoteFor(null) }} />
                    <span className="qc-acts">
                      <button type="button" className="btn primary sm" disabled={!note.trim() || busy === f.id} onClick={() => verdict(f, 'accepted', note)}>Accept</button>
                      <button type="button" className="btn ghost sm" onClick={() => setNoteFor(null)}>Cancel</button>
                    </span>
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
