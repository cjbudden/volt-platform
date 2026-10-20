import { SocialComposer, SocialPanel } from './SocialPublish'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { IngestPanel } from '../IngestPanel'
import { api } from '../api'
import { ClipProvenancePanel } from '../ClipProvenance'
import { navigate } from '../router'
import { Notice, PageError, useNotify, usePageNotice } from '../notices'
import MediaPreview from '../MediaPreview'
import SkipMarkers from '../SkipMarkers'
import { RuleEditor } from '../RuleEditor'
import { MetadataForm, TypePicker } from '../ContentTypeFields'
import type { AssetAvailability } from '../api'
import { useRoute } from '../router'
import { BulkBar, SelectAllHead, SelectCell, bulkSummary, runBulk, useSelection } from '../listActions'
import { NoMatches, usePref } from '../listFilters'
import { LibraryFilterPanel, LibraryToolbar } from './vod/LibraryFilters'
import { LibraryGrid } from './vod/LibraryGrid'
import { AvailabilityPill, Completeness, Keyscreen, TypeLabel } from './vod/LibraryCells'
import { EncodePanel, TargetMetadataPanel } from './vod/AssetPanels'
import { libraryApi, type LibraryFacets, type LibraryRow } from './vod/libraryApi'
import { VIEWS, codecLabel, filtersToApi, filtersToSearch, isFiltered, parseColumns, parseFilters, resLabel, type LibraryFilters, type LibraryView } from './vod/libraryQuery'
import { LibIcon } from './vod/icons'
import './vod/library.css'

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
function AssetDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [tab, setTab] = useState<'play' | 'markers' | 'sources' | 'publishing' | 'availability' | 'metadata' | 'encode'>('play')
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
  const playable = !!(file || hls)
  // Social posts have their own panel below (progress, retry, take down);
  // this table keeps the portal and app publishing points.
  const pubs = (d.publications ?? []).filter((p: any) => p.platform === 'portal' || p.platform === 'app')

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label)
    try { await fn(); await load(); onChanged() } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  return (
    <div style={{ padding: '8px 2px 14px' }}>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        {(['play', 'markers', 'metadata', 'encode', 'availability', 'sources', 'publishing'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'primary' : 'ghost'}`}
            style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
            onClick={() => setTab(t)}>
            {t === 'play' ? 'Preview' : t === 'markers' ? 'Skip markers' : t === 'metadata' ? 'Metadata' : t === 'encode' ? 'Encode' : t === 'availability' ? 'Availability' : t === 'sources' ? 'Where it came from' : 'Where it went'}
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

      {tab === 'play' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, alignItems: 'start' }}>
          <div>
            {playable ? (
              <MediaPreview sources={{ file, hls }} audioOnly={audioOnly} title={d.title} thumbnailsVtt={thumbsVtt} />
            ) : (
              <div style={{
                height: 200, background: 'var(--panel-2)', borderRadius: 8,
                display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 'var(--fs-sm)',
              }}>
                {/* An asset with no file is not an error state on its own: the
                    extraction job may still be running. Saying which it is beats
                    an empty player. */}
                {d.thumb_status === 'processing' ? 'Still being extracted…' : 'No rendered file for this asset.'}
              </div>
            )}
            {audioOnly && (
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
                Audio only{d.recording_id ? ': cut from an audio source' : ''}.
              </div>
            )}
          </div>
          <div>
            <div className="sec-label">Facts</div>
            <table>
              <tbody>
                <tr><td style={{ color: 'var(--faint)' }}>Kind</td><td>{d.kind}</td></tr>
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
                  <td style={{ color: QC_TONE[d.qc_state] ?? 'var(--muted)' }}>{d.qc_state ?? 'not run'}</td></tr>
              </tbody>
            </table>
            {d.master_key && (
              <div style={{ marginTop: 10 }}>
                <a className="btn ghost" href={d.master_key} target="_blank" rel="noreferrer">HLS manifest</a>
                {d.progressive_key && (
                  <a className="btn ghost" style={{ marginLeft: 6 }} href={d.progressive_key} download>Download MP4</a>
                )}
                {d.export_mp3_key && (
                  <a className="btn ghost" style={{ marginLeft: 6 }} href={d.export_mp3_key} download>Download MP3</a>
                )}
                {d.export_m4a_key && (
                  <a className="btn ghost" style={{ marginLeft: 6 }} href={d.export_m4a_key} download title="The AAC exactly as broadcast, no re-encode">AAC (.m4a)</a>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'markers' && <SkipMarkers asset={d} />}

      {tab === 'sources' && <ClipProvenancePanel assetId={d.id} />}

      {tab === 'publishing' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <div className="sec-label" style={{ margin: 0 }}>Publishing points</div>
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
        </div>
      )}

      {tab === 'metadata' && (
        <>
          <TargetMetadataPanel asset={d} reloadKey={Date.parse(d.updated_at ?? '') || 0} onChanged={() => { load(); onChanged() }} />
          {/* keyed on updated_at so an EPG fill shows in the form at once */}
          <AssetMetadata key={d.updated_at ?? ''} d={d} onSaved={() => { load(); onChanged() }} />
        </>
      )}

      {tab === 'encode' && <EncodePanel id={d.id} />}

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
  return (
    <div style={{ maxWidth: 820 }}>
      <TypePicker appliesTo="vod" value={typeId} onChange={(id) => setTypeId(id)}
        hint="Inherited from the channel, station or event it was cut from. Change it to describe this item differently." />
      <MetadataForm typeId={typeId} value={meta} onChange={setMeta} compact />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true); setErr('')
          try { await api.patchVodAsset(d.id, { schemaId: typeId, metadata: meta } as any); onSaved() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
        }}>{busy ? 'Saving…' : 'Save metadata'}</button>
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
      </div>
    </div>
  )
}

/* WHERE IT GOES AND HOW LONG IT STAYS. The resolved plan (with the rung each
   field came from), the item's own overrides, and the three actions. */
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
        {a.applied && ' The values applied at the last publish are shown in "Where it went".'}
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
  const columns = parseColumns(colPref)

  const [cursor, setCursor] = useState<string | null>(null)
  const [pageNo, setPageNo] = useState(0)
  const [page, setPage] = useState<{ rows: LibraryRow[]; total: number | null; next: string | null; prev: string | null } | null>(null)
  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
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
      <div className="page-head">
        <div>
          <h1>Media Library</h1>
          <p>Everything that has been cut or uploaded, what it is, how it was encoded, and where it went.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      <IngestPanel onDone={load} />

      <LibraryToolbar filters={filters} onChange={setFilters} view={view} onView={setView}
        columns={columns} onColumns={(c) => setColPref(c.join(','))} />
      <LibraryFilterPanel filters={filters} onChange={setFilters} facets={facets} />

      <BulkBar count={sel.sel.size} noun={['asset', 'assets']} onClear={sel.clear} busy={bulkBusy}
        actions={[
          { key: 'epg', label: 'Fill from EPG', icon: LibIcon.epg, count: fromGuide.length, onRun: bulkEpg,
            hint: fromGuide.length < sel.sel.size ? 'Uploaded files have no guide slot. Only empty fields are filled, and only from a clear programme match.' : 'Only empty fields are filled, and only from a clear programme match.' },
          { key: 'publish', label: 'Publish', icon: LibIcon.publish, count: unpublished.length, onRun: bulkPublish,
            hint: unpublished.length < sel.sel.size ? 'Assets that are already available or scheduled are left out' : undefined },
        ]} />

      {!page ? <div className="loading">Loading the library…</div> : rows.length === 0 ? (
        filtered ? <NoMatches what="assets" onClear={() => setFilters({ ...parseFilters(''), sort: filters.sort })} />
          : <div className="empty"><h3>Nothing here yet</h3><p>Clips appear once they are cut from a recording, and files once they are uploaded.</p></div>
      ) : view === 'grid' ? (
        <>
          <div className="lib-grid-head">
            <label className="lib-selall">
              <input type="checkbox" checked={sel.allOn} ref={(el) => { if (el) el.indeterminate = sel.someOn && !sel.allOn }} onChange={sel.toggleAll} aria-label="Select all shown" />
              Select all shown
            </label>
          </div>
          <LibraryGrid rows={rows} selected={sel.sel} onToggle={sel.toggle} onOpen={(id) => setOpen(id)} openId={open} />
          {open && (
            <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) setOpen(null) }}>
              <div className="drawer lib-drawer-asset" role="dialog" aria-modal="true" aria-label="Asset" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(null) }}>
                <div className="drawer-h">
                  <span className="t">{rows.find((r) => r.id === open)?.title || 'Untitled'}</span>
                  <button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label="Close" autoFocus>{LibIcon.close}</button>
                </div>
                <div className="drawer-b"><AssetDetail id={open} onChanged={load} /></div>
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
                    <tr onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }} className={sel.sel.has(a.id) ? 'sel' : undefined}>
                      <SelectCell on={sel.sel.has(a.id)} onToggle={() => sel.toggle(a.id)} label={`Select ${a.title || 'Untitled'}`} />
                      <td>
                        <div className="lib-title-cell">
                          <Keyscreen row={a} w={96} h={54} className="sm" />
                          <div className="min-w-0">
                            <b>{a.title || 'Untitled'}</b>
                            <div><EncodeState a={x} /></div>
                          </div>
                        </div>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {x.source_name ?? (x.source_kind === 'upload' ? 'Uploaded' : x.source_kind === 'watchfolder' ? 'Watchfolder' : '')}
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
                        <button className="btn ghost" onClick={e => { e.stopPropagation(); setOpen(open === a.id ? null : a.id) }} aria-expanded={open === a.id}>
                          {open === a.id ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>
                    {open === a.id && (
                      <tr><td colSpan={10 + extraCols} style={{ background: 'var(--panel-2)' }}>
                        <AssetDetail id={a.id} onChanged={load} />
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
    </>
  )
}
