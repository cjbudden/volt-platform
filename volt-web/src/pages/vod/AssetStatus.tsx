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
  qc_failed: 'Plays, but QC found an error. Fix it, or approve it in review to use it anyway.',
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
    : s === 'qc_failed' ? 'QC found an error in this media. It plays, but is held back from FAST, loops and blocking until it is fixed or approved in review.'
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

/**
 * WHAT QC LOOKED AT. "pass" on its own said nothing about what passed (or that
 * nothing was measured). Each check is listed: what it found, that it was
 * clean, or that it could not run and why.
 */
export function QcChecks({ id, state, at }: { id: string; state: string | null; at: string | null }) {
  const [findings, setFindings] = useState<QcFinding[] | null>(null)
  useEffect(() => {
    let gone = false
    api.assetReview(id).then((r) => { if (!gone) setFindings(r.qc.findings) }).catch(() => { if (!gone) setFindings([]) })
    return () => { gone = true }
  }, [id, state, at])
  if (!state || !findings) return null
  const notRun = (f: QcFinding) => f.severity === 'info' && /^Not checked:/.test(f.message)
  const rows = ALL_CHECKS.map((c) => {
    const fs = findings.filter((f) => f.check_name === c)
    const real = fs.filter((f) => !notRun(f))
    const skip = fs.find(notRun)
    const worst = real.find((f) => f.severity === 'error') ?? real.find((f) => f.severity === 'warning') ?? real[0]
    return { c, worst, skip, more: Math.max(0, real.length - 1) }
  }).filter((r) => r.worst || r.skip || r.c === 'media' || r.c === 'playback' || r.c === 'duration')
  return (
    <ul className="qc-checks" aria-label="QC checks">
      {rows.map(({ c, worst, skip, more }) => {
        const tone = worst ? (worst.severity === 'error' ? 'bad' : worst.severity === 'warning' ? 'warn' : 'info') : skip ? 'skip' : 'ok'
        const text = worst ? worst.message : skip ? skip.message.replace(/^Not checked: /, 'Not checked: ') : 'OK'
        return (
          <li key={c} className={`qc-check ${tone}`}>
            <span className="qc-check-ic" aria-hidden="true">{tone === 'ok' ? LibIcon.check : tone === 'skip' ? LibIcon.empty : tone === 'info' ? LibIcon.info : LibIcon.alert}</span>
            <span className="qc-check-n">{CHECK_LABEL[c] ?? c}</span>
            <span className="qc-check-m">{text}{more ? ` (+${more} more)` : ''}</span>
          </li>
        )
      })}
    </ul>
  )
}
