import { SocialComposer, SocialPanel } from './SocialPublish'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { IngestPanel } from '../IngestPanel'
import { api, apiRequest, thumbUrl } from '../api'
import DeleteAssetDialog, { type DeletedAsset } from '../DeleteAssetDialog'
import { ClipProvenancePanel } from '../ClipProvenance'
import { navigate } from '../router'
import { Notice, PageError, useNotify, usePageNotice } from '../notices'
import MediaPreview from '../MediaPreview'
import { AssetImage } from './vod/AssetImage'
import { confirmLeave, setUnsaved, stable } from './vod/unsaved'
import { AssetFiles } from './vod/AssetFiles'
import { useLibraryChanges, posterVersion } from './vod/useLibraryChanges'
import { useAssetsChanged } from '../assetEvents'
import { useDrawerWidth, DrawerResizeHandle, WidthButton } from './vod/drawerWidth'
import { signImage } from '../imageSigning'
import { AssetHistory } from './vod/AssetHistory'
import SkipMarkers from '../SkipMarkers'
import { RuleEditor } from '../RuleEditor'
import { MetadataForm, TypePicker } from '../ContentTypeFields'
import type { AssetAvailability } from '../api'
import { useRoute } from '../router'
import { BulkBar, SelectAllHead, SelectCell, bulkSummary, runBulk, useSelection } from '../listActions'
import { NoMatches, usePref } from '../listFilters'
import { LibraryFilterPanel, LibraryToolbar } from './vod/LibraryFilters'
import { LibraryGrid } from './vod/LibraryGrid'
import { AvailabilityPill, Completeness, Keyscreen, KindLegend, TypeLabel } from './vod/LibraryCells'
import { DownloadFiles, EncodePanel, TargetMetadataPanel } from './vod/AssetPanels'
import FormatsPanel from './vod/FormatsPanel'
import { libraryApi, type LibraryFacets, type LibraryRow } from './vod/libraryApi'
import { VIEWS, codecLabel, filtersToApi, filtersToSearch, isFiltered, parseColumns, parseFilters, resLabel, type LibraryFilters, type LibraryView } from './vod/libraryQuery'
import { LibIcon } from './vod/icons'
import { AssetStatusPanel, QcChecks, UsageBadge, USAGE_LABEL, hasNoMedia } from './vod/AssetStatus'
import './vod/library.css'
import { SourceFacts } from './vod/SourceFacts'
import { AddToCollectionDialog, CollectionTree, ColIcon, NewCollection, collectionsApi, flatten, pathName, useCollections } from './vod/collections'

/* ============================================================================
   MEDIA LIBRARY — everything that was cut or uploaded, and what state it is in.

   The list is organised around the question an operator actually arrives with,
   which is almost never "show me all assets". It is one of:

     what is waiting on me            → review state
     what went out, and is it current → published, and whether the copy is stale
     what came from this channel      → source
     where did THIS come from         → the provenance chain

   So those are the filters, and the row carries the answers rather than making
   you open each one. The detail pane below a row is the same provenance panel
   the recordings page uses: one chain, shown the same way wherever it is asked
   about.

   WHAT THIS PAGE DOES NOT DO is duplicate the review queue. Review is a place of
   work with its own ordering; this is the library. They share the same underlying
   state and say so, but a library sorted by "what needs attention" would be a
   worse library and a worse queue.
   ========================================================================== */

const REVIEW_TONE: Record<string, string> = {
  approved: 'var(--ok,#4ade80)',
  rejected: 'var(--danger,#f87171)',
  changes_requested: 'var(--warn,#fbbf24)',
  in_review: 'var(--brand,#3f7bff)',
  draft: 'var(--faint)',
}
const REVIEW_LABEL: Record<string, string> = {
  draft: 'Draft', in_review: 'In review', changes_requested: 'Changes requested',
  approved: 'Approved', rejected: 'Rejected',
}
const QC_TONE: Record<string, string> = {
  pass: 'var(--ok,#4ade80)', warnings: 'var(--warn,#fbbf24)', failed: 'var(--danger,#f87171)',
}

/* ---------------------------------------------------------------------------
   THE ENCODE, for an asset that came from a file.

   AN ASSET WITH NO MASTER PLAYLIST IS NOT BROKEN, it is still being made, and
   the two look identical in a list unless the list says which. So the encode
   state is shown on the row rather than only inside a job screen, and a failed
   encode says so where somebody will see it.

   WHAT WAS DROPPED IS SHOWN TOO. Three renditions beside four is a question
   operators ask, and the answer is on the asset because the job that made the
   decision has long since been pruned.
   -------------------------------------------------------------------------*/
function EncodeState({ a }: { a: any }) {
  const st = a.encode_state as string | null | undefined
  const src = a.source_kind as string | undefined
  if (!src || src === 'recording') return null

  if (st === 'queued' || st === 'running') {
    return (
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--brand,#3f7bff)', fontWeight: 600 }}
        title={a.encode_note ?? 'Waiting for a worker'}>
        {st === 'queued' ? 'Queued to encode' : `Encoding ${a.encode_pct ?? 0}%`}
      </span>
    )
  }
  if (st === 'failed' || st === 'cancelled') {
    return (
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger,#f87171)', fontWeight: 600 }}
        title={a.encode_error ?? ''}>
        Encode {st === 'failed' ? 'failed' : 'cancelled'}
      </span>
    )
  }
  const r = a.encode_result
  if (!r) return null
  return (
    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)' }}
      title={[
        r.ladder?.name ? `Ladder: ${r.ladder.name}` : '',
        ...(r.notes ?? []),
      ].filter(Boolean).join('\n')}>
      {r.summary ?? (r.kept ?? []).map((x: any) => `${x.height}p`).join(', ')}
      {r.sourceUnmeasured ? ' · source not measured' : ''}
    </span>
  )
}

function fmtDur(ms: number | string | null | undefined) {
  const s = Math.round(Number(ms ?? 0) / 1000)
  if (!s) return '—'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${m}:${String(ss).padStart(2, '0')}`
}


// ---------------------------------------------------------------------------
//  One asset, expanded
// ---------------------------------------------------------------------------
function AssetDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted?: (a: DeletedAsset) => void }) {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [tab, setTab] = useState<'play' | 'markers' | 'history' | 'availability' | 'metadata' | 'files' | 'encode' | 'formats'>('play')
  const [composeOpen, setComposeOpen] = useState(false)
  const [socialKey, setSocialKey] = useState(0)
  async function load() {
    try { setD(await api.vodAsset(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])
  // HOVER PREVIEWS: the clip's thumbnail VTT (cues re-timed from the channel's
  // hourly sprite sheets). Optional: no VTT, no strip.
  const [thumbsVtt, setThumbsVtt] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    setThumbsVtt(null)
    api.vodThumbnailsVtt(id).then(v => { if (!gone) setThumbsVtt(v) }).catch(() => { /* none yet */ })
    return () => { gone = true }
  }, [id])
  const notify = useNotify()
  usePageNotice('asset-load', err && d ? { kind: 'error', title: "Couldn't refresh this asset.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  // Only when there is nothing to show: `err` is also written by Publish, so
  // an unconditional guard let one rejected publish replace the whole asset
  // panel with a line of red text and no way back.
  if (err && !d) return <Notice kind="error" variant="compact" title="Couldn't load this asset." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />
  if (!d) return <div className="loading">Loading…</div>

  // WHAT TO PLAY. A progressive file when there is one (instant seeking), the
  // HLS manifest otherwise; MediaPreview handles both and puts up an audio
  // surface or a video one on the server's word (`audioOnly`).
  const audioOnly: boolean = d.audioOnly === true
  const file = audioOnly ? (d.export_mp3_key || d.export_m4a_key || d.progressive_key || null) : (d.progressive_key || null)
  const hls = d.master_key || null
  // NOTHING TO PLAY IS SAID, NOT TRIED. A clip whose build failed still has a
  // master_key (the placeholder it was created with), so the player used to
  // load it and report "Playback failed" with no reason. The usage status
  // (volt-app services/assetReadiness.ts) knows there is no media and why.
  const noMedia = hasNoMedia(d.usage_status) || d.usage_status === 'processing'
  const playable = !!(file || hls) && !noMedia
  // Social posts have their own panel below (progress, retry, take down);
  // this table keeps the portal and app publishing points.
  const pubs = (d.publications ?? []).filter((p: any) => p.platform === 'portal' || p.platform === 'app')

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label)
    try {
      await fn(); await load(); onChanged()
      if (label === 'qc') notify({ kind: 'ok', message: 'QC is running again. The result shows here when it finishes.' })
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  return (
    <div style={{ padding: '8px 2px 14px' }}>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        {(['play', 'markers', 'metadata', 'files', 'encode', 'formats', 'availability', 'history'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'primary' : 'ghost'}`}
            style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
            onClick={() => { if (t !== tab && !confirmLeave()) return; setTab(t) }}>
            {t === 'play' ? 'Preview' : t === 'markers' ? 'Skip markers' : t === 'metadata' ? 'Metadata' : t === 'files' ? 'Companion files' : t === 'encode' ? 'Encode' : t === 'formats' ? 'Formats' : t === 'availability' ? 'Availability' : 'History'}
          </button>
        ))}
        <AvailabilityBadge state={d.availability_state} until={d.available_until} />
        <div className="flex-1" />
        {d.recording_id && (
          <button className="btn ghost" onClick={() => navigate(`/recordings/${d.recording_id}`)}>
            Open the recording
          </button>
        )}
        <button className="btn ghost" disabled={!!busy}
          onClick={() => act(() => api.rerunQc(d.id), 'qc')}>
          {busy === 'qc' ? 'Queued…' : 'Re-run QC'}
        </button>
      </div>

      {tab === 'play' && <AssetStatusPanel asset={d} onChanged={() => { load(); onChanged() }} />}
      {tab === 'play' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, alignItems: 'start' }}>
          <div>
            {playable ? (
              <MediaPreview sources={{ file, hls }} audioOnly={audioOnly} title={d.title} thumbnailsVtt={thumbsVtt}
                poster={d.poster_key ? signImage(`1280x720,${d.poster_shape === 'square' ? 'contain,bg=000000' : 'cover'}${posterVersion(d.poster_picked_at) ? `,v=${posterVersion(d.poster_picked_at)}` : ''}`, String(d.poster_key)) ?? thumbUrl(`/${String(d.poster_key).replace(/^\/+/, '')}`, 1280, 720, 'cover') : null} />
            ) : (
              <div style={{
                height: 200, background: 'var(--panel-2)', borderRadius: 8,
                display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 'var(--fs-sm)',
              }}>
                {/* An asset with no file is not an error state on its own: the
                    extraction job may still be running. Saying which it is beats
                    an empty player. */}
                {d.usage_status === 'processing' ? (d.ingest?.status === 'awaiting_metadata' ? 'Encoding… The content type also needs required metadata (see Metadata) before the ingest completes.' : 'Still being built…')
                  : d.usage_status === 'failed' ? 'The build failed: there is no media to play.'
                  : d.usage_status === 'unplayable' ? 'The media will not decode, so it is not played here.'
                  : 'No media for this asset.'}
              </div>
            )}
            {audioOnly && (
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
                Audio only{d.recording_id ? ': cut from an audio source' : ''}.
              </div>
            )}
            {/* THE SOURCE FILE AS DELIVERED: container, bitrates, codecs, resolution, colour (vod/SourceFacts.tsx). */}
            {(d.source_kind === 'upload' || d.source_kind === 'watchfolder') && d.ingest?.probe && (
              <SourceFacts probe={d.ingest.probe} bytes={d.source_bytes} filename={d.original_filename} mime={d.mime} />
            )}
            {/* reload THIS drawer too: a song applied from the finder changes the content type and metadata shown below */}
            <AssetImage id={d.id} onChanged={() => { load(); onChanged() }} />
          </div>
          <div>
            <div className="sec-label">Facts</div>
            <table>
              <tbody>
                <tr><td style={{ color: 'var(--faint)' }}>Status</td><td>{d.usage_status ? <UsageBadge row={d} /> : '—'}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Kind</td><td>{d.kind}</td></tr>
                {(d.source_kind === 'upload' || d.source_kind === 'watchfolder') && <>
                  {/* THE SOURCE (mezzanine) FILE: kept as uploaded; every rendition is made from it. */}
                  <tr><td style={{ color: 'var(--faint)' }}>Source file</td>
                    <td style={{ wordBreak: 'break-all' }}>{d.original_filename ?? '—'}{d.source_bytes ? ` · ${(Number(d.source_bytes) / 1048576).toFixed(Number(d.source_bytes) > 1073741824 ? 0 : 1)} MB` : ''}
                      {d.ingest?.probe?.width ? ` · ${d.ingest.probe.width}×${d.ingest.probe.height}` : d.encode_result?.probe?.width ? ` · ${d.encode_result.probe.width}×${d.encode_result.probe.height}` : ''}</td></tr>
                  {d.sha256 && <tr><td style={{ color: 'var(--faint)' }}>SHA-256</td><td className="mono" title={d.sha256}>{String(d.sha256).slice(0, 16)}…</td></tr>}
                  <tr><td style={{ color: 'var(--faint)' }}>Ladder</td>
                    <td>{d.encode_result?.ladder?.name ?? '—'}{d.encode_result?.ladder?.origin?.kind === 'tracked' ? ` (tracks the live profile${d.encode_result.ladder.origin.profileName ? ` ${d.encode_result.ladder.origin.profileName}` : ''})` : ''}
                      {Array.isArray(d.encode_result?.kept) ? ` · ${d.encode_result.kept.map((r: any) => `${r.height}p`).join(', ')}` : ''}</td></tr>
                  <tr><td style={{ color: 'var(--faint)' }}>Formats</td>
                    <td>{[d.formats?.hls && 'HLS', d.formats?.dash && 'DASH', d.formats?.progressive && 'MP4'].filter(Boolean).join(' · ') || '—'}</td></tr>
                </>}
                <tr><td style={{ color: 'var(--faint)' }}>Duration</td><td>{fmtDur(d.duration_ms)}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Output</td><td>{d.output_kind ?? 'manifest'}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Built</td>
                  <td>{d.build_strategy ?? '—'}{d.built_at ? ` · ${new Date(d.built_at).toLocaleString()}` : ''}</td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Coverage</td>
                  <td style={{ color: d.source_coverage_pct != null && Number(d.source_coverage_pct) < 100 ? 'var(--warn,#fbbf24)' : undefined }}>
                    {d.source_coverage_pct != null ? `${d.source_coverage_pct}%` : '—'}
                  </td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>Review</td>
                  <td style={{ color: REVIEW_TONE[d.review_state ?? 'draft'] }}>
                    {REVIEW_LABEL[d.review_state ?? 'draft']}
                  </td></tr>
                <tr><td style={{ color: 'var(--faint)' }}>QC</td>
                  <td style={{ color: QC_TONE[d.qc_state] ?? 'var(--muted)' }}>{d.qc_state ?? 'not run'}{d.qc_at ? <span style={{ color: 'var(--faint)' }}> · {new Date(d.qc_at).toLocaleString()}</span> : null}</td></tr>
              </tbody>
            </table>
            <QcChecks id={d.id} state={d.qc_state ?? null} at={d.qc_at ?? null} />
            {d.master_key && !noMedia && (
              <div style={{ marginTop: 10 }}>
                <a className="btn ghost" href={d.master_key} target="_blank" rel="noreferrer">HLS manifest</a>
                {/* Downloads follow the Downloads permission (modules/downloads.ts), not the page. */}
                <DownloadFiles id={d.id} compact />
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'markers' && <SkipMarkers asset={d} />}

      {/* HISTORY: what happened to it, newest first; then where it is published; then what it was made from. */}
      {tab === 'history' && (
        <div>
          <div className="sec-label" style={{ marginTop: 0 }}>History</div>
          <AssetHistory id={d.id} refreshKey={socialKey + (Date.parse(d.updated_at ?? '') || 0)} />
          <div style={{ display: 'flex', alignItems: 'center', margin: '20px 0 10px' }}>
            <div className="sec-label" style={{ margin: 0 }}>Published to</div>
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={() => setComposeOpen(true)}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M12 3v12M7 8l5-5 5 5" /></svg>
              Publish to social
            </button>
          </div>
          {pubs.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', padding: '6px 0' }}>
              This asset has not been published anywhere.
            </div>
          ) : (
            <table>
              <thead><tr><th>Where</th><th>Status</th><th>Published</th><th>As approved</th><th>Views</th><th /></tr></thead>
              <tbody>
                {pubs.map((p: any, i: number) => (
                  <tr key={i}>
                    <td>{p.platform === 'app'
                      ? <span>App: {p.app_name ?? p.app_id?.slice(0, 8)} <button className="btn ghost" style={{ padding: '0 6px', fontSize: 'var(--fs-micro)' }} onClick={() => navigate('/apikeys')}>registration</button></span>
                      : p.target_name ? `${p.platform}: ${p.target_name}` : p.platform}</td>
                    <td style={{ color: 'var(--muted)' }}>{p.status}</td>
                    <td style={{ color: 'var(--muted)' }}>
                      {p.published_at ? new Date(p.published_at).toLocaleString() : '—'}
                    </td>
                    <td>
                      {/* The point of stamping the publication: what went out was
                          approved, and this says whether the copy out there is
                          still the copy that was. */}
                      {p.stale
                        ? <span style={{ color: 'var(--warn,#fbbf24)' }}>re-cut since — the copy out there is older</span>
                        : <span style={{ color: 'var(--muted)' }}>
                            {p.published_review_state ?? '—'}
                            {p.published_qc_state ? ` · QC ${p.published_qc_state}` : ''}
                          </span>}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{p.views ?? 0}</td>
                    <td style={{ textAlign: 'right' }}>
                      {p.external_url && (
                        <a className="btn ghost" href={p.external_url} target="_blank" rel="noreferrer">Open</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 12, fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
            Publishing goes through the asset's rules: see the Availability tab. App publications link to the app's registration under API Keys & Apps.
          </div>
          <SocialPanel assetId={d.id} refreshKey={socialKey} />
          {composeOpen && <SocialComposer assetId={d.id} onClose={() => setComposeOpen(false)} onPublished={() => { setSocialKey(k => k + 1); load(); onChanged() }} />}
          <details className="hist-src">
            <summary>Where it came from: the recordings, files and segments it was made from</summary>
            <ClipProvenancePanel assetId={d.id} />
          </details>
        </div>
      )}

      {tab === 'metadata' && (
        <>
          <TargetMetadataPanel asset={d} reloadKey={Date.parse(d.updated_at ?? '') || 0} onChanged={() => { load(); onChanged() }} />
          {/* keyed on updated_at so an EPG fill shows in the form at once */}
          <AssetMetadata key={d.updated_at ?? ''} d={d} onSaved={() => { load(); onChanged() }} />
          <DeleteAsset d={d} onDeleted={(a) => { onChanged(); onDeleted?.(a) }} />
        </>
      )}

      {/* COMPANION FILES: captions as subtitle tracks, metadata sidecars to apply (docs/COMPANION_FILES.md). */}
      {tab === 'files' && <AssetFiles id={d.id} onMetadataApplied={() => { load(); onChanged() }} />}

      {tab === 'encode' && (
        <>
          {/* The encode job behind this asset: its outputs, thumbnails, sprites and log. */}
          {d.encode_job_id && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button className="btn ghost sm" onClick={() => navigate(`/encode-jobs/${d.encode_job_id}`)}>Encode job and log</button>
            </div>
          )}
          <EncodePanel id={d.id} />
        </>
      )}

      {/* SOCIAL FORMATS: 9:16, 1:1 and 4:5 framed by following the picture (volt/REFRAME.md). */}
      {tab === 'formats' && <FormatsPanel asset={d} />}

      {tab === 'availability' && (
        <AvailabilityPanel d={d} onChanged={() => { load(); onChanged() }} />
      )}
    </div>
  )
}

const STATE_UI: Record<string, { label: string; color: string }> = {
  draft: { label: 'Not published', color: 'var(--faint)' },
  scheduled: { label: 'Scheduled', color: 'var(--brand,#3f7bff)' },
  available: { label: 'Available', color: 'var(--ok,#4ade80)' },
  expired: { label: 'Expired', color: 'var(--warn,#fbbf24)' },
  withdrawn: { label: 'Access removed', color: 'var(--danger,#f87171)' },
}
function AvailabilityBadge({ state, until }: { state?: string | null; until?: string | null }) {
  const ui = STATE_UI[state ?? 'draft'] ?? STATE_UI.draft
  return (
    <span style={{ fontSize: 'var(--fs-sm)', color: ui.color, fontWeight: 600, marginLeft: 6 }} title={until ? `until ${new Date(until).toLocaleString()}` : undefined}>
      ● {ui.label}{state === 'available' && until ? ` until ${new Date(until).toLocaleDateString()}` : ''}
    </span>
  )
}

/* The asset's type and metadata. Inherited from the owner at creation, editable here. */
function AssetMetadata({ d, onSaved }: { d: any; onSaved: () => void }) {
  const [typeId, setTypeId] = useState<string | null>(d.schema_id ?? null)
  const [meta, setMeta] = useState<Record<string, any>>(d.metadata ?? {})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const notify = useNotify()
  // Images added in this form go in the asset's own library folder (docs/ASSET_IMAGES.md section 7).
  const [imgFolder, setImgFolder] = useState<string | null>(null)
  useEffect(() => { apiRequest(`/vod/${d.id}/image`).then((r: any) => setImgFolder(r?.folder ?? null)).catch(() => { /* default folder */ }) }, [d.id])
  // UNSAVED CHANGES ARE VISIBLE. The form differs from what is saved: the save
  // bar says so, Save stands out, and leaving (tab, another asset, closing the
  // drawer or the page) asks first. An image chosen here only takes effect on Save.
  const saved = useMemo(() => stable({ t: d.schema_id ?? null, m: d.metadata ?? {} }), [d])
  const dirty = !busy && stable({ t: typeId, m: meta }) !== saved
  const what = `"${meta.title || d.title || 'this asset'}"`
  useEffect(() => {
    setUnsaved(dirty ? what : null)
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, what])
  useEffect(() => () => setUnsaved(null), [])
  const discard = () => { setTypeId(d.schema_id ?? null); setMeta(d.metadata ?? {}); setErr('') }
  const save = async () => {
    setBusy(true); setErr('')
    // SAY HOW IT WENT, in the page's notice area: a save that only turned a
    // button back from "Saving…" left people unsure whether it had worked.
    try {
      const r: any = await api.patchVodAsset(d.id, { schemaId: typeId, metadata: meta } as any)
      const imageNote = r?.poster_key && r.poster_key !== d.poster_key ? ' The asset\'s image was updated.' : ''
      setUnsaved(null)
      notify({ id: 'asset-save', kind: 'ok', message: `Saved the metadata for ${what}.${imageNote}` })
      onSaved()
    } catch (e: any) {
      setErr(e.message)
      notify({ id: 'asset-save', kind: 'error', title: 'The metadata was not saved.', message: e.message })
    } finally { setBusy(false) }
  }
  return (
    <div style={{ maxWidth: 820 }}>
      <TypePicker appliesTo="vod" value={typeId} onChange={(id) => setTypeId(id)}
        hint="Inherited from the channel, station or event it was cut from. Change it to describe this item differently." />
      <MetadataForm typeId={typeId} value={meta} onChange={setMeta} compact imageFolder={imgFolder ?? undefined} />
      <div role="status" aria-live="polite" style={{ position: 'sticky', bottom: 0, zIndex: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 12px', margin: '8px -12px 0', background: dirty ? 'color-mix(in srgb, var(--warn, #d97706) 14%, var(--panel))' : 'var(--panel)',
        borderTop: `1px solid ${dirty ? 'var(--warn, #d97706)' : 'var(--border)'}` }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : dirty ? 'Save changes' : 'Save metadata'}</button>
        {dirty && <button className="btn ghost" disabled={busy} onClick={discard}>Discard</button>}
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: dirty ? 600 : 400, color: dirty ? 'var(--warn, #d97706)' : 'var(--faint)' }}>
          {busy ? 'Saving…' : dirty ? '● Unsaved changes: nothing here is saved until you press Save changes.' : 'All changes saved.'}
        </span>
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
      </div>
    </div>
  )
}

/* WHERE IT GOES AND HOW LONG IT STAYS. The resolved plan (with the rung each
   field came from), the item's own overrides, and the three actions. */
// DELETE, INTO THE RESTORE BIN, with the same dialog workflow as removing a channel or
// station (DeleteAssetDialog): what goes, why it cannot go now, type the title to
// confirm. The record and its media go to Storage > Recently removed for the bin's days,
// so the page offers Undo straight after (POST /api/vod/:id/restore).
function DeleteAsset({ d, onDeleted }: { d: any; onDeleted: (a: DeletedAsset) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="danger-zone">
      <div>
        <div className="dz-t">Delete this asset</div>
        <div className="dz-d">Removes the asset with its metadata and media files. You will see exactly what goes and type the title to confirm. It can be restored from Storage &gt; Recently removed for a few days.</div>
      </div>
      <button className="btn ghost danger" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>Delete asset
      </button>
      {open && <DeleteAssetDialog id={d.id} onClose={() => setOpen(false)} onDeleted={(a) => { setOpen(false); onDeleted(a) }} />}
    </div>
  )
}

function AvailabilityPanel({ d, onChanged }: { d: any; onChanged: () => void }) {
  const [a, setA] = useState<AssetAvailability | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const notify = useNotify()
  async function load() { try { setA(await api.vodAvailability(d.id)) } catch (e: any) { setErr(e.message) } }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [d.id])
  async function act(label: string, fn: () => Promise<any>, ok: string) {
    setBusy(label); setErr('')
    try { await fn(); notify({ kind: 'ok', message: ok }); await load(); onChanged() } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  if (!a) return <div className="loading">{err || 'Loading availability…'}</div>
  const ui = STATE_UI[a.state] ?? STATE_UI.draft
  const live = a.state === 'available' || a.state === 'scheduled'
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '10px 12px', borderRadius: 8, border: `1px solid ${ui.color}55`, background: `${ui.color}10`, marginBottom: 12 }}>
        <b style={{ color: ui.color }}>{ui.label}</b>
        {a.availableFrom && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>from {new Date(a.availableFrom).toLocaleString()}</span>}
        {a.availableUntil && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>until {new Date(a.availableUntil).toLocaleString()}</span>}
        {a.state === 'withdrawn' && a.withdrawnAt && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>removed {new Date(a.withdrawnAt).toLocaleString()} by {a.withdrawnBy}</span>}
        <span style={{ flex: 1 }} />
        {!live && (
          <button className="btn primary" disabled={!!busy} onClick={() => act('pub', () => api.publishVod(d.id), 'Published through its rules.')}>
            {busy === 'pub' ? 'Publishing…' : a.state === 'draft' ? 'Publish' : 'Publish again'}
          </button>
        )}
        {live && (
          <button className="btn ghost" disabled={!!busy} style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.5)' }}
            onClick={() => { const r = window.prompt('Remove access to this item now? The item is kept; nothing will serve it. Reason (optional):'); if (r !== null) act('wd', () => api.withdrawVod(d.id, r || undefined), 'Access removed.') }}>
            {busy === 'wd' ? 'Removing…' : 'Remove access'}
          </button>
        )}
      </div>

      <div className="sec-label">What a publish does for this item</div>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 8 }}>
        Resolved from the ladder: account default, then its content type, then its channel / event / station, then this item.
        {a.applied && ' The values applied at the last publish are shown in History, under "Published to".'}
      </div>
      <RuleEditor scopeKind="asset" scopeId={d.id} compact resolveQuery={{ assetId: d.id }} onSaved={() => { load(); onChanged() }} />

      {a.publications.length > 0 && (
        <>
          <div className="sec-label">Publishing points</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {a.publications.map(p => (
              <span key={p.id} className="chip" style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)', opacity: p.status === 'published' ? 1 : .6 }}
                title={`${p.status}${p.published_at ? ` · ${new Date(p.published_at).toLocaleString()}` : ''}`}>
                {p.platform === 'app' ? `App: ${p.app_name ?? ''}` : p.platform === 'portal' ? 'Catalogue' : `${p.platform}: ${p.target_name ?? ''}`} · {p.status}
              </span>
            ))}
          </div>
        </>
      )}
      {err && <div style={{ marginTop: 8 }}><Notice kind="error" variant="compact" message={err} /></div>}
    </div>
  )
}

// ---------------------------------------------------------------------------


/* ============================================================================
   THE LIBRARY: list or grid, filtered, sorted and paged on the server.

   The filters live in the URL (/vod?type=…&missing=1), so a view can be shared;
   the list or grid choice and the optional table columns are remembered in
   this browser. Selection, the bulk bar and the row detail work the same in
   both views. See pages/vod/ and DESIGN_media_library.md, "Library views".
   ========================================================================== */
const PAGE = 48

export default function VodPage() {
  useRoute() // re-render when the URL (the filters) changes
  const filters = parseFilters(window.location.search)
  const apiQs = filtersToApi(filters, { limit: PAGE })
  const facetQs = filtersToApi(filters, { facets: true })
  const setFilters = (f: LibraryFilters) => navigate(`/vod${filtersToSearch(f)}`, { replace: true })

  const [view, setView] = usePref<LibraryView>('vod.view', 'list', VIEWS)
  const [colPref, setColPref] = usePref<string>('vod.columns', 'type,complete')
  // COLLECTIONS (vod/collections.tsx): the rail on the left, the bulk Add / Remove.
  const cols = useCollections()
  const [rail, setRail] = usePref<string>('vod.rail', 'on', ['on', 'off'])
  const [adding, setAdding] = useState<string[] | null>(null)
  const [newCol, setNewCol] = useState(false)
  const columns = parseColumns(colPref)

  const [cursor, setCursor] = useState<string | null>(null)
  const [pageNo, setPageNo] = useState(0)
  const [page, setPage] = useState<{ rows: LibraryRow[]; total: number | null; next: string | null; prev: string | null } | null>(null)
  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // Unsaved edits in the open asset's form: ask before switching or closing (vod/unsaved.ts).
  const guardOpen = (v: string | null) => { if (v !== open && !confirmLeave()) return; setOpen(v) }
  // DEEP LINK (?asset=<id>), from the metadata log, the guide strip, the Live
  // Streams timeline and the EPG drawer (programmeMedia.tsx). The asset opens
  // in a drawer over the library whatever page or filter it is on.
  const linked = new URLSearchParams(window.location.search).get('asset')
  const closeLinked = () => {
    const q = new URLSearchParams(window.location.search); q.delete('asset')
    navigate(`/vod${q.toString() ? `?${q}` : ''}`, { replace: true })
  }
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const notify = useNotify()

  // A new filter or sort starts again at the first page.
  useEffect(() => { setCursor(null); setPageNo(0) }, [apiQs])
  useEffect(() => {
    let gone = false
    libraryApi.page(cursor ? `${apiQs}&cursor=${encodeURIComponent(cursor)}` : apiQs)
      .then((p) => { if (!gone) { setPage(p); setErr('') } })
      .catch((e) => { if (!gone) setErr(e.message) })
    return () => { gone = true }
  }, [apiQs, cursor, tick])
  useEffect(() => {
    let gone = false
    libraryApi.facets(facetQs).then((f) => { if (!gone) setFacets(f) }).catch(() => { /* chips show without counts */ })
    return () => { gone = true }
  }, [facetQs, tick])
  const load = () => setTick((t) => t + 1)
  // Cards update in place when an asset changes (an image chosen or picked in the
  // background, a title, availability): light polling, see vod/useLibraryChanges.ts.
  // WHICH CARD IS WHICH: the open asset's card is ringed (and stays marked "last opened"
  // after the panel closes), and a card that just changed pulses with "Updated" for a few
  // seconds, whether the change came from the open panel or from the poll below.
  const [lastOpen, setLastOpen] = useState<string | null>(null)
  // The asset panel's width: drag its left edge or use the width button (vod/drawerWidth.tsx).
  const panel = useDrawerWidth()
  useEffect(() => { if (open) setLastOpen(open) }, [open])
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const markFresh = (ids: (string | null | undefined)[]) => {
    const list = ids.filter(Boolean) as string[]
    if (!list.length) return
    setFresh((f) => new Set([...f, ...list]))
    window.setTimeout(() => setFresh((f) => { const n = new Set(f); list.forEach((i) => n.delete(i)); return n }), 4000)
  }
  const changedHere = (id: string | null | undefined) => () => { load(); markFresh([id]) }
  // Saved elsewhere in this console (the ingest queue's Fill in): reload the page now,
  // so the metadata bar, status and counts are current without waiting or polling.
  useAssetsChanged((ids) => { load(); markFresh(ids) })
  useLibraryChanges(
    (changed) => setPage((p) => {
      if (!p) return p
      const by = new Map(changed.map((c) => [c.id, c]))
      if (!p.rows.some((r) => by.has(r.id))) return p
      window.setTimeout(() => markFresh(p.rows.filter((r) => by.has(r.id)).map((r) => r.id)), 0)
      return { ...p, rows: p.rows.map((r) => (by.has(r.id) ? { ...r, ...by.get(r.id)! } as LibraryRow : r)) }
    }),
    load,
  )

  // DELETED FROM THE FORM: close it, drop it from the list and offer Undo while the
  // notice is up (the bin keeps it for binDays either way).
  function assetDeleted(a: DeletedAsset) {
    if (linked === a.id) closeLinked()
    setOpen((o) => (o === a.id ? null : o))
    load()
    const until = a.purgeAfter ? new Date(a.purgeAfter).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
    notify({
      id: 'asset-delete', kind: 'ok', autoHideMs: 30000,
      title: `Deleted "${a.title}".`,
      message: `It is in Storage > Recently removed for ${a.binDays} day${a.binDays === 1 ? '' : 's'}${until ? ` (until ${until})` : ''}, and can be restored from there until then.`,
      actions: [{
        label: 'Undo',
        onClick: async () => {
          try {
            await api.restoreVod(a.id)
            load()
            setOpen(a.id)
            notify({ id: 'asset-delete', kind: 'ok', message: `"${a.title}" is back, with its metadata and media.` })
          } catch (e: any) {
            notify({ id: 'asset-delete', kind: 'error', title: `"${a.title}" could not be restored.`, message: e.message })
          }
        },
      }],
    })
  }
  usePageNotice('load', err && page ? { kind: 'error', title: "Couldn't load the library.", message: err, actions: [{ label: 'Retry', onClick: load }] } : null)

  const rows = page?.rows ?? []
  const ids = useMemo(() => rows.map((r) => r.id), [rows])
  const sel = useSelection(ids)
  const chosen = rows.filter((r) => sel.sel.has(r.id))
  const fromGuide = chosen.filter((r) => r.channel_id || r.event_id || (r as any).origin === 'clip' || (r as any).origin === 'recording')
  const unpublished = chosen.filter((r) => !r.published && r.availability_state !== 'available' && r.availability_state !== 'scheduled')

  async function bulkEpg() {
    setBulkBusy(`Filling ${fromGuide.length} from the guide…`)
    try {
      const r = await libraryApi.epgBulk(fromGuide.map((x) => x.id), { title: true })
      const why = r.results.filter((x) => !x.applied.length && !x.titleChanged && x.reason)
      const name = (id: string) => rows.find((x) => x.id === id)?.title || 'Untitled'
      notify({ kind: r.filled ? 'ok' : 'info', message: [`Filled ${r.filled} from the guide. Empty fields only, nothing typed was replaced.`, ...why.slice(0, 4).map((x) => `${name(x.assetId)}: ${x.reason}`), why.length > 4 ? `${why.length - 4} more left as they were.` : ''].filter(Boolean).join(' ') })
      sel.clear(); load()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBulkBusy(null) }
  }
  async function bulkRemoveFromCollection() {
    if (!filters.col) return
    setBulkBusy(`Taking ${chosen.length} out…`)
    try {
      const r = await collectionsApi.take(filters.col, chosen.map((x) => x.id))
      const left = chosen.length - r.removed
      notify({ kind: 'ok', message: `Took ${r.removed} out of ${pathName(cols.rows ?? [], filters.col)}. The assets stay in the library.${left ? ` ${left} ${left === 1 ? 'is' : 'are'} in a sub-collection: open that one to take ${left === 1 ? 'it' : 'them'} out.` : ''}` })
      sel.clear(); load(); cols.reload()
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBulkBusy(null) }
  }
  async function bulkPublish() {
    setBulkBusy(`Publishing ${unpublished.length}…`)
    const res = await runBulk(unpublished.map((r) => ({ id: r.id, name: r.title || 'Untitled' })), (r) => api.publishVod(r.id), (n) => setBulkBusy(`Publishing ${n} of ${unpublished.length}…`))
    notify({ kind: res.failed.length ? 'warn' : 'ok', message: bulkSummary('Published', res) })
    setBulkBusy(null); sel.clear(); load()
  }

  if (err && !page) return <PageError message={err} onRetry={load} />

  const total = page?.total ?? null
  const first = pageNo * PAGE + 1
  const filtered = isFiltered(filters)
  const show = (c: string) => columns.includes(c as any)
  const extraCols = ['type', 'complete', 'encode', 'codec', 'renditions', 'blocks'].filter(show).length

  return (
    <>
      {linked && (
        <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) closeLinked() }}>
          <div className="drawer lib-drawer-asset" role="dialog" aria-modal="true" aria-label="Asset" style={panel.style} onKeyDown={(e) => { if (e.key === 'Escape') closeLinked() }}>
            <DrawerResizeHandle width={panel.width} setWidth={panel.setWidth} />
            <div className="drawer-h">
              <span className="t">{rows.find((r) => r.id === linked)?.title || 'Asset'}</span>
              <WidthButton current={panel.current} next={panel.next} onClick={panel.cycle} />
              <button type="button" className="icon-btn" onClick={closeLinked} aria-label="Close" autoFocus>{LibIcon.close}</button>
            </div>
            <div className="drawer-b"><AssetDetail id={linked} onChanged={changedHere(linked)} onDeleted={assetDeleted} /></div>
          </div>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>Media Library</h1>
          <p>Everything that has been cut or uploaded, what it is, how it was encoded, and where it went.</p>
        </div>
        <div className="spacer" />
        {(() => {
          const unchecked = facets?.facets.usage?.find((f) => f.value === 'unchecked')?.n ?? 0
          return unchecked > 0 ? (
            <button className="btn ghost" title={`${USAGE_LABEL.unchecked}: not offered to FAST, loops or blocking until QC confirms they play`}
              onClick={async () => {
                try { const r = await api.qcUnchecked(); notify({ kind: 'ok', message: `QC queued for ${r.queued} asset${r.queued === 1 ? '' : 's'}. Statuses update as each finishes.` }); load() }
                catch (e: any) { notify({ kind: 'error', message: e.message }) }
              }}>Check {unchecked} not checked</button>
          ) : null
        })()}
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      <IngestPanel onDone={load} />

      {adding && <AddToCollectionDialog assetIds={adding} onClose={() => setAdding(null)} onDone={() => { sel.clear(); cols.reload() }} />}
      <div className={`lib-layout${rail === 'off' ? ' rail-off' : ''}`}>
      {rail !== 'off' && (
        <aside className="card lib-rail" aria-label="Collections">
          <div className="lib-rail-h">Collections<span className="spacer" />
            <button className="fast-ico" title="New collection" aria-label="New collection" onClick={() => setNewCol((v) => !v)}>{ColIcon.plus}</button>
            <button className="fast-ico" title="Hide collections" aria-label="Hide collections" onClick={() => setRail('off')}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m15 6-6 6 6 6" /></svg></button>
          </div>
          <div className={`col-row lib-rail-all${!filters.col ? ' on' : ''}`} onClick={() => setFilters({ ...filters, col: '' })} tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setFilters({ ...filters, col: '' }) }}>
            <span className="col-tw" />{ColIcon.all}<span className="col-nm">All media</span>
          </div>
          {newCol && cols.rows && <div style={{ padding: '4px 4px 8px' }}><NewCollection rows={cols.rows} parentId={filters.col || null} maxDepth={cols.maxDepth}
            onCancel={() => setNewCol(false)} onCreated={(c) => { setNewCol(false); cols.reload(); setFilters({ ...filters, col: c.id }) }} /></div>}
          {cols.rows && !cols.rows.length && !newCol && <div className="hintxt" style={{ padding: '6px 10px' }}>Group assets your way: a collection per channel or show, with sub-collections for each week's playlist. Select assets and use <b>Add to collection</b>.</div>}
          <CollectionTree tree={cols.tree} selected={filters.col || null} onSelect={(c) => setFilters({ ...filters, col: c.id })} />
          <div className="lib-rail-f">
            {filters.col && <label><input type="checkbox" checked={filters.colDeep} onChange={(e) => setFilters({ ...filters, colDeep: e.target.checked })} /> Include sub-collections</label>}
            <button className="btn ghost sm" onClick={() => navigate(filters.col ? `/collections/${filters.col}` : '/collections')}>Manage collections</button>
          </div>
        </aside>
      )}
      <div className="lib-main">
      <div className="lib-rail-mobile">
        <select className="inp" value={filters.col} onChange={(e) => setFilters({ ...filters, col: e.target.value })} aria-label="Collection">
          <option value="">All media</option>
          {flatten(cols.tree).map((n) => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.depth ? '└ ' : ''}{n.name} ({n.totalCount})</option>)}
        </select>
        <button className="btn ghost sm" onClick={() => navigate('/collections')}>Manage</button>
      </div>
      {(filters.col || rail === 'off') && (
        <div className="lib-colbar">
          {rail === 'off' && <button className="btn ghost sm" onClick={() => setRail('on')}>{ColIcon.folder} Collections</button>}
          {filters.col && cols.rows && (
            <span className="crumb">{ColIcon.folder}
              <a href="/vod" onClick={(e) => { e.preventDefault(); setFilters({ ...filters, col: '' }) }}>All media</a> /{' '}
              {pathName(cols.rows, filters.col).split(' / ').map((nm, i, a) => {
                const id = (() => { let c = cols.rows!.find((x) => x.id === filters.col); for (let k = a.length - 1; k > i && c; k--) c = cols.rows!.find((x) => x.id === c!.parentId); return c?.id })()
                return i < a.length - 1
                  ? <Fragment key={i}><a href={`/vod?col=${id}`} onClick={(e) => { e.preventDefault(); if (id) setFilters({ ...filters, col: id }) }}>{nm}</a> /{' '}</Fragment>
                  : <Fragment key={i}>{nm}</Fragment>
              })}
            </span>
          )}
          {filters.col && <span>{filters.colDeep ? 'with its sub-collections' : 'this collection only'}</span>}
        </div>
      )}
      <LibraryToolbar filters={filters} onChange={setFilters} view={view} onView={setView}
        columns={columns} onColumns={(c) => setColPref(c.join(','))} />
      <LibraryFilterPanel filters={filters} onChange={setFilters} facets={facets} />

      <BulkBar count={sel.sel.size} noun={['asset', 'assets']} onClear={sel.clear} busy={bulkBusy}
        actions={[
          { key: 'epg', label: 'Fill from EPG', icon: LibIcon.epg, count: fromGuide.length, onRun: bulkEpg,
            hint: fromGuide.length < sel.sel.size ? 'Uploaded files have no guide slot. Only empty fields are filled, and only from a clear programme match.' : 'Only empty fields are filled, and only from a clear programme match.' },
          { key: 'publish', label: 'Publish', icon: LibIcon.publish, count: unpublished.length, onRun: bulkPublish,
            hint: unpublished.length < sel.sel.size ? 'Assets that are already available or scheduled are left out' : undefined },
          { key: 'collect', label: 'Add to collection', icon: ColIcon.addTo, count: chosen.length, onRun: () => setAdding(chosen.map((x) => x.id)),
            hint: 'Add the selected assets to a collection, or make a new one' },
          ...(filters.col ? [{ key: 'uncollect', label: 'Remove from collection', icon: ColIcon.out, count: chosen.length, onRun: bulkRemoveFromCollection,
            hint: `Take the selected assets out of ${pathName(cols.rows ?? [], filters.col)}. They stay in the library.` }] : []),
        ]} />

      {!page ? <div className="loading">Loading the library…</div> : rows.length === 0 ? (
        filters.col && !isFiltered({ ...filters, col: '' }) ? <div className="empty"><h3>This collection is empty</h3><p>Go to <b>All media</b>, select assets in the list or grid, and use <b>Add to collection</b>.</p></div>
        : filtered ? <NoMatches what="assets" onClear={() => setFilters({ ...parseFilters(''), sort: filters.sort, col: filters.col, colDeep: filters.colDeep })} />
          : <div className="empty"><h3>Nothing here yet</h3><p>Clips appear once they are cut from a recording, and files once they are uploaded.</p></div>
      ) : view === 'grid' ? (
        <>
          <div className="lib-grid-head">
            <label className="lib-selall">
              <input type="checkbox" checked={sel.allOn} ref={(el) => { if (el) el.indeterminate = sel.someOn && !sel.allOn }} onChange={sel.toggleAll} aria-label="Select all shown" />
              Select all shown
            </label>
            <div style={{ marginLeft: 'auto' }}><KindLegend /></div>
          </div>
          <LibraryGrid rows={rows} selected={sel.sel} onToggle={sel.toggle} onOpen={(id) => guardOpen(id)} openId={open} lastOpenId={lastOpen} fresh={fresh} />
          {open && !linked && (
            <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) guardOpen(null) }}>
              <div className="drawer lib-drawer-asset" role="dialog" aria-modal="true" aria-label="Asset" style={panel.style} onKeyDown={(e) => { if (e.key === 'Escape') guardOpen(null) }}>
                <DrawerResizeHandle width={panel.width} setWidth={panel.setWidth} />
                <div className="drawer-h">
                  <span className="t">{rows.find((r) => r.id === open)?.title || 'Untitled'}</span>
                  <WidthButton current={panel.current} next={panel.next} onClick={panel.cycle} />
                  <button type="button" className="icon-btn" onClick={() => guardOpen(null)} aria-label="Close" autoFocus>{LibIcon.close}</button>
                </div>
                <div className="drawer-b"><AssetDetail id={open} onChanged={changedHere(open)} onDeleted={assetDeleted} /></div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="card lib-table-card">
          <table className="lib-table">
            <thead>
              <tr>
                <SelectAllHead allOn={sel.allOn} someOn={sel.someOn} onToggle={sel.toggleAll} label="Select all shown" />
                <th scope="col">Title</th>
                <th scope="col">Source</th>
                <th scope="col">Length</th>
                {show('type') && <th scope="col">Content type</th>}
                {show('complete') && <th scope="col">Metadata</th>}
                {show('encode') && <th scope="col">Top rendition</th>}
                {show('codec') && <th scope="col">Codec</th>}
                {show('renditions') && <th scope="col">Renditions</th>}
                {show('blocks') && <th scope="col">Sources</th>}
                <th scope="col">Review</th><th scope="col">QC</th><th scope="col">Availability</th><th scope="col">Cut</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const x = a as any
                return (
                  <Fragment key={a.id}>
                    <tr onClick={() => guardOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }} aria-current={open === a.id ? 'true' : undefined}
                      className={[sel.sel.has(a.id) ? 'sel' : '', open === a.id ? 'lib-row-open' : '', fresh.has(a.id) ? 'lib-fresh' : ''].filter(Boolean).join(' ') || undefined}>
                      <SelectCell on={sel.sel.has(a.id)} onToggle={() => sel.toggle(a.id)} label={`Select ${a.title || 'Untitled'}`} />
                      <td>
                        <div className="lib-title-cell">
                          <Keyscreen row={a} w={96} h={54} className="sm" />
                          <div className="min-w-0">
                            <b>{a.title || 'Untitled'}</b>
                            <div><EncodeState a={x} />{a.usage_status && a.usage_status !== 'ready' && <> <UsageBadge row={a} /></>}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {x.source === 'none' ? <span className="lib-faint">No source</span>
                          : x.source === 'upload' ? (x.source_kind === 'watchfolder' ? 'Upload · watch folder' : 'Upload')
                          : <>{x.source_name ?? ''}<span className="lib-faint">{x.source ? ` · ${({ channel: 'Channel', event: 'Event', radio: 'Radio' } as Record<string, string>)[x.source] ?? ''}` : ''}</span></>}
                      </td>
                      <td className="mono" style={{ color: 'var(--muted)' }}>{fmtDur(a.duration_ms)}</td>
                      {show('type') && <td><TypeLabel row={a} /></td>}
                      {show('complete') && <td><Completeness row={a} /></td>}
                      {show('encode') && <td>{a.top_height ? resLabel(a.top_height) : <span className="lib-faint">Not known</span>}</td>}
                      {show('codec') && <td>{codecLabel(a.video_codec) || <span className="lib-faint">Not known</span>}</td>}
                      {show('renditions') && <td>{a.rendition_count ?? <span className="lib-faint">Not known</span>}</td>}
                      {show('blocks') && (
                        <td style={{ color: 'var(--muted)' }}>
                          {a.source_block_count == null ? <span className="lib-faint">Not recorded</span>
                            : `${a.source_block_count} block${a.source_block_count === 1 ? '' : 's'}`}
                          {(a.source_container_count ?? 0) > 1 && <span style={{ color: 'var(--warn,#fbbf24)' }}> · {a.source_container_count} days</span>}
                        </td>
                      )}
                      <td style={{ color: REVIEW_TONE[x.review_state ?? 'draft'], fontSize: 'var(--fs-sm)' }}>{REVIEW_LABEL[x.review_state ?? 'draft']}</td>
                      <td style={{ color: QC_TONE[x.qc_state] ?? 'var(--faint)', fontSize: 'var(--fs-sm)' }}>{x.qc_state ?? 'not run'}</td>
                      <td><AvailabilityPill row={a} />{x.has_stale_publication && <div className="lib-faint lib-small">copy is old</div>}</td>
                      <td style={{ color: 'var(--muted)' }}>{new Date(a.created_at).toLocaleDateString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost" onClick={e => { e.stopPropagation(); guardOpen(open === a.id ? null : a.id) }} aria-expanded={open === a.id}>
                          {open === a.id ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>
                    {open === a.id && (
                      <tr><td colSpan={10 + extraCols} style={{ background: 'var(--panel-2)' }}>
                        <AssetDetail id={a.id} onChanged={changedHere(a.id)} onDeleted={assetDeleted} />
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {page && rows.length > 0 && (
        <nav className="lib-pager" aria-label="Pages">
          <span className="lib-faint">
            {total != null ? `${first} to ${first + rows.length - 1} of ${total}` : `${first} to ${first + rows.length - 1}`}
          </span>
          <button type="button" className="btn ghost sm" disabled={!page.prev && pageNo === 0} onClick={() => { setCursor(page.prev); setPageNo((n) => Math.max(0, n - 1)) }}>
            {LibIcon.prev}Previous
          </button>
          <button type="button" className="btn ghost sm" disabled={!page.next} onClick={() => { setCursor(page.next); setPageNo((n) => n + 1) }}>
            Next{LibIcon.next}
          </button>
        </nav>
      )}
      </div>
      </div>
    </>
  )
}
