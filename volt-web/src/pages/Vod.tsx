import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { startUpload, subscribe, type UploadItem } from '../uploadManager'
import type { LadderGroup } from '../api'
import { api, type VodAssetRow } from '../api'
import { ClipProvenancePanel } from '../ClipProvenance'
import { navigate } from '../router'
import MediaPreview from '../MediaPreview'
import { RuleEditor } from '../RuleEditor'
import { MetadataForm, TypePicker } from '../ContentTypeFields'
import type { AssetAvailability } from '../api'

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

type Filter = 'all' | 'published' | 'unpublished' | 'in_review' | 'approved' | 'stale'

// ---------------------------------------------------------------------------
//  One asset, expanded
// ---------------------------------------------------------------------------
function AssetDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [tab, setTab] = useState<'play' | 'sources' | 'publishing' | 'availability' | 'metadata'>('play')
  async function load() {
    try { setD(await api.vodAsset(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])

  // Only when there is nothing to show: `err` is also written by Publish, so
  // an unconditional guard let one rejected publish replace the whole asset
  // panel with a line of red text and no way back.
  if (err && !d) return <div className="err">{err}</div>
  if (!d) return <div className="loading">Loading…</div>

  // WHAT TO PLAY. A progressive file when there is one (instant seeking), the
  // HLS manifest otherwise; MediaPreview handles both and puts up an audio
  // surface or a video one on the server's word (`audioOnly`).
  const audioOnly: boolean = d.audioOnly === true
  const file = audioOnly ? (d.export_mp3_key || d.export_m4a_key || d.progressive_key || null) : (d.progressive_key || null)
  const hls = d.master_key || null
  const playable = !!(file || hls)
  const pubs = d.publications ?? []

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label); setErr('')
    try { await fn(); await load(); onChanged() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  return (
    <div style={{ padding: '8px 2px 14px' }}>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        {(['play', 'metadata', 'availability', 'sources', 'publishing'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'primary' : 'ghost'}`}
            style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
            onClick={() => setTab(t)}>
            {t === 'play' ? 'Preview' : t === 'metadata' ? 'Metadata' : t === 'availability' ? 'Availability' : t === 'sources' ? 'Where it came from' : 'Where it went'}
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
              <MediaPreview sources={{ file, hls }} audioOnly={audioOnly} title={d.title} />
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

      {tab === 'sources' && <ClipProvenancePanel assetId={d.id} />}

      {tab === 'publishing' && (
        <div>
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
        </div>
      )}

      {tab === 'metadata' && (
        <AssetMetadata d={d} onSaved={() => { load(); onChanged() }} />
      )}

      {tab === 'availability' && (
        <AvailabilityPanel d={d} onChanged={() => { load(); onChanged() }} />
      )}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
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
  const [msg, setMsg] = useState('')
  async function load() { try { setA(await api.vodAvailability(d.id)) } catch (e: any) { setErr(e.message) } }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [d.id])
  async function act(label: string, fn: () => Promise<any>, ok: string) {
    setBusy(label); setErr(''); setMsg('')
    try { await fn(); setMsg(ok); await load(); onChanged() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
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
      {msg && <div style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>{msg}</div>}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------

/* ---------------------------------------------------------------------------
   UPLOADING A VIDEO FILE.

   The ladder is chosen HERE and not at encode time, because it is the one
   decision an operator has an opinion about and the only moment they are
   holding the file in mind. Leaving it blank is a real choice too — it takes
   the account default AT ENCODE TIME, so a default changed during a two-hour
   upload is still the one that applies.

   THE PROGRESS IS ON THE PAGE, not in a modal that vanishes. A programme is not
   a slate: the interesting states are the ones an hour in, where something goes
   wrong and the operator needs to still be looking at it.
   -------------------------------------------------------------------------*/
/** One line on what the ingest rules decided, worded for the operator. */
function ingestLabel(g: UploadItem['ingest']): string {
  if (!g) return 'uploaded, encoding next'
  switch (g.status) {
    case 'ingested': return g.naming?.renamed ? 'uploaded and filed, encoding next' : 'uploaded, encoding next'
    case 'awaiting_metadata': return `uploaded, waiting for ${(g.awaitingMetadata ?? []).join(', ') || 'metadata'}`
    case 'duplicate': return g.duplicate?.outcome === 'skip' ? 'skipped, already in the library' : 'already in the library, needs a decision'
    case 'rejected': return 'refused by an ingest rule'
    default: return 'uploaded'
  }
}

function UploadPanel({ onDone }: { onDone: () => void }) {
  const [ladders, setLadders] = useState<LadderGroup[]>([])
  const [ladderId, setLadderId] = useState('')
  const [items, setItems] = useState<UploadItem[]>([])
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const folderRef = useRef<HTMLInputElement | null>(null)
  const depth = useRef(0)

  useEffect(() => { api.ladderGroups().then(setLadders).catch(() => setLadders([])) }, [])
  useEffect(() => subscribe((all) => {
    setItems(all)
    // Refresh the library as each upload lands, so the new asset appears with
    // its encode already in flight rather than after a manual refresh.
    if (all.some(i => i.status === 'done')) onDone()
  }), [onDone])

  const send = async (files: File[]) => {
    setErr('')
    for (const f of files) {
      try {
        await startUpload(f, { kind: 'loop', purpose: 'vod', ladderGroupId: ladderId || null })
      } catch (e: any) { setErr(String(e?.message ?? e)) }
    }
  }

  const active = items.filter(i => i.status !== 'done' || Date.now() - i.startedAt < 60_000)
  const chosen = ladders.find(l => l.id === ladderId)

  return (
    <div className="card" style={{ padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--fs-body)' }}>Upload video</strong>
        <select value={ladderId} onChange={e => setLadderId(e.target.value)}
          style={{ background: 'var(--panel-2,#151922)', border: '1px solid var(--border,#242a36)',
                   color: 'var(--text,#e7ebf3)', borderRadius: 8, padding: '6px 9px',
                   fontFamily: 'inherit', fontSize: 'var(--fs-sm)' }}>
          <option value="">The account default ladder</option>
          {ladders.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}{l.tracks_output_profile_id ? ' (tracks live)' : ''}
              {l.rungs.length ? ` — ${l.rungs.map(r => r.height + 'p').join('/')}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <button type="button" className="btn" onClick={() => folderRef.current?.click()}>
          Choose folder
        </button>
        <input ref={inputRef} type="file" accept="video/*,audio/*" multiple hidden
          onChange={e => { send([...(e.target.files ?? [])]); e.target.value = '' }} />
        {/* A folder pick keeps each file's path inside the folder
            (webkitRelativePath), which the ingest rules can honour or flatten. */}
        <input ref={folderRef} type="file" multiple hidden {...({ webkitdirectory: '' } as any)}
          onChange={e => { send([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>

      <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint,#8b93a7)', margin: '8px 0 0' }}>
        {chosen?.tracks_output_profile_id
          ? <>Encoded to the same ladder as the channels using <strong>{chosen.tracked_profile_name}</strong>, read at encode time so it cannot drift from them.</>
          : chosen
            ? <>Encoded to this ladder{chosen.cap_to_source ? ', skipping any rung above the source\u2019s own height' : ', including rungs above the source'}.</>
            : <>Encoded to whichever ladder is the account default when the encode runs.</>}
      </p>

      <div
        onDragEnter={e => { e.preventDefault(); depth.current++; setOver(true) }}
        onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) setOver(false) }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault(); depth.current = 0; setOver(false)
          send([...(e.dataTransfer?.files ?? [])])
        }}
        style={{
          marginTop: 10, padding: '18px 14px', borderRadius: 10, textAlign: 'center',
          border: `1px dashed ${over ? 'var(--brand,#3f7bff)' : 'var(--border,#242a36)'}`,
          background: over ? 'rgba(63,123,255,.08)' : 'transparent',
          fontSize: 'var(--fs-sm)', color: 'var(--faint,#8b93a7)',
        }}>
        Drop video files here
      </div>

      {err && <p style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)' }}>{err}</p>}

      {active.map(i => (
        <div key={i.id} style={{ marginTop: 8, fontSize: 'var(--fs-sm)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {i.name}
            </span>
            <span style={{ color: 'var(--faint,#8b93a7)' }}>
              {i.status === 'done' ? ingestLabel(i.ingest)
                : i.status === 'error' ? (i.error ?? 'failed')
                : `${Math.round((i.sentBytes / Math.max(1, i.totalBytes)) * 100)}%`}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--panel-2,#151922)', marginTop: 4 }}>
            <div style={{
              height: '100%', borderRadius: 2,
              width: `${Math.round((i.sentBytes / Math.max(1, i.totalBytes)) * 100)}%`,
              background: i.status === 'error' ? 'var(--danger,#f87171)' : 'var(--brand,#3f7bff)',
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function VodPage() {
  const [rows, setRows] = useState<VodAssetRow[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  async function load() {
    try { setRows(await api.vodAssets()); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  const counts = useMemo(() => {
    const r = rows ?? []
    return {
      all: r.length,
      published: r.filter(a => (a as any).published).length,
      unpublished: r.filter(a => !(a as any).published).length,
      in_review: r.filter(a => (a as any).review_state === 'in_review'
        || (a as any).review_state === 'changes_requested').length,
      approved: r.filter(a => (a as any).review_state === 'approved').length,
      stale: r.filter(a => (a as any).has_stale_publication).length,
    }
  }, [rows])

  const shown = (rows ?? []).filter(a => {
    const x = a as any
    if (q && !`${a.title ?? ''} ${x.source_name ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false
    switch (filter) {
      case 'published': return !!x.published
      case 'unpublished': return !x.published
      case 'in_review': return x.review_state === 'in_review' || x.review_state === 'changes_requested'
      case 'approved': return x.review_state === 'approved'
      case 'stale': return !!x.has_stale_publication
      default: return true
    }
  })

  if (err && !rows) return <div className="err">{err}</div>
  if (!rows) return <div className="loading">Loading the library…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Media Library</h1>
          <p>Everything that has been cut, where it came from, and where it went.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div className="err">{err}</div>}

      <UploadPanel onDone={load} />

      <div className="card">
        <div className="flex flex-wrap items-center gap-2" style={{ padding: '12px 14px 0' }}>
          {(['all', 'published', 'unpublished', 'in_review', 'approved', 'stale'] as const).map(f => (
            <button key={f} className={`btn ${filter === f ? 'primary' : 'ghost'}`}
              style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
              onClick={() => setFilter(f)}>
              {f === 'all' ? 'All'
                : f === 'in_review' ? 'Needs review'
                : f === 'stale' ? 'Published copy is old'
                : f[0].toUpperCase() + f.slice(1)}
              <span style={{ color: 'var(--faint)', marginLeft: 6 }}>{counts[f]}</span>
            </button>
          ))}
          <div className="flex-1" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by title or source…"
            style={{ width: 240 }} />
        </div>
        <table>
          <thead>
            <tr><th>Title</th><th>Source</th><th>Length</th><th>Sources</th><th>Review</th><th>QC</th><th>Availability</th><th>Cut</th><th /></tr>
          </thead>
          <tbody>
            {shown.map(a => {
              const x = a as any
              return (
                <Fragment key={a.id}>
                  <tr onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <b>{a.title || 'Untitled'}</b>
                      {/* An asset with no master is still being made, not
                          broken; a list that cannot tell them apart sends
                          people looking for a fault that is not there. */}
                      <div><EncodeState a={x} /></div>
                    </td>
                    <td style={{ color: 'var(--muted)' }}>
                      {x.source_name ?? (x.source_kind === 'upload' ? 'Uploaded'
                        : x.source_kind === 'watchfolder' ? 'Watchfolder' : '—')}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{fmtDur(a.duration_ms)}</td>
                    <td style={{ color: 'var(--muted)' }}>
                      {a.source_block_count == null ? <span style={{ color: 'var(--faint)' }}>—</span>
                        : `${a.source_block_count} block${a.source_block_count === 1 ? '' : 's'}`}
                      {(a.source_container_count ?? 0) > 1 && (
                        <span style={{ color: 'var(--warn,#fbbf24)' }}> · {a.source_container_count} days</span>
                      )}
                    </td>
                    <td style={{ color: REVIEW_TONE[x.review_state ?? 'draft'], fontSize: 'var(--fs-sm)' }}>
                      {REVIEW_LABEL[x.review_state ?? 'draft']}
                    </td>
                    <td style={{ color: QC_TONE[x.qc_state] ?? 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
                      {x.qc_state ?? 'not run'}
                    </td>
                    <td style={{ fontSize: 'var(--fs-sm)' }}>
                      {(() => {
                        const st = (x.availability_state ?? (x.published ? 'available' : 'draft')) as string
                        const ui = STATE_UI[st] ?? STATE_UI.draft
                        return <span style={{ color: ui.color }} title={x.available_until ? `until ${new Date(x.available_until).toLocaleString()}` : undefined}>
                          {ui.label}{st === 'available' && x.has_stale_publication ? ', copy is old' : ''}
                        </span>
                      })()}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{new Date(a.created_at).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost" onClick={e => { e.stopPropagation(); setOpen(open === a.id ? null : a.id) }}>
                        {open === a.id ? 'Close' : 'Open'}
                      </button>
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr><td colSpan={9} style={{ background: 'var(--panel-2)' }}>
                      <AssetDetail id={a.id} onChanged={load} />
                    </td></tr>
                  )}
                </Fragment>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan={9} style={{ color: 'var(--faint)' }}>
                {rows.length === 0
                  ? 'Nothing here yet. Clips appear once they are cut from a recording.'
                  : 'Nothing matches that filter.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
