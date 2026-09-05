import { Fragment, useEffect, useMemo, useState } from 'react'
import { api, type VodAssetRow } from '../api'
import { ClipProvenancePanel } from '../ClipProvenance'
import { navigate } from '../router'

/* ============================================================================
   VOD LIBRARY — everything that was cut, and what state it is in.

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
  const [tab, setTab] = useState<'play' | 'sources' | 'publishing'>('play')
  // Whether the rendered file actually has a picture. Asked of the element
  // rather than assumed from the asset, because a clip cut from a radio station
  // is audio and a 380px black rectangle is a poor way to say so.
  const [hasPicture, setHasPicture] = useState<boolean | null>(null)

  async function load() {
    try { setD(await api.vodAsset(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])

  // Only when there is nothing to show: `err` is also written by Publish, so
  // an unconditional guard let one rejected publish replace the whole asset
  // panel with a line of red text and no way back.
  if (err && !d) return <div className="err">{err}</div>
  if (!d) return <div className="loading">Loading…</div>

  // A <video> can only play a PROGRESSIVE file directly. `master_key` is an
  // HLS/DASH manifest, and this used to treat either as "playable" while
  // handing the element only `progressive_key` — so a clip cut with the
  // DEFAULT output (Streaming) rendered an inert black box with controls,
  // forever, and the honest "no rendered file" branch became unreachable for
  // exactly the assets that needed it.
  const progressive = d.progressive_key || null
  const manifestOnly = !progressive && !!d.master_key
  const pubs = d.publications ?? []

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label); setErr('')
    try { await fn(); await load(); onChanged() } catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  return (
    <div style={{ padding: '8px 2px 14px' }}>
      <div className="flex flex-wrap items-center gap-2" style={{ marginBottom: 12 }}>
        {(['play', 'sources', 'publishing'] as const).map(t => (
          <button key={t} className={`btn ${tab === t ? 'primary' : 'ghost'}`}
            style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
            onClick={() => setTab(t)}>
            {t === 'play' ? 'Preview' : t === 'sources' ? 'Where it came from' : 'Where it went'}
          </button>
        ))}
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
            {progressive ? (
              <video controls playsInline preload="metadata"
                src={progressive}
                onLoadedMetadata={e => setHasPicture((e.currentTarget as HTMLVideoElement).videoHeight > 0)}
                style={hasPicture === false
                  ? { width: '100%', height: 44, background: '#000', borderRadius: 8, border: '1px solid var(--border)' }
                  : { width: '100%', maxHeight: 380, background: '#000', borderRadius: 8, border: '1px solid var(--border)' }} />
            ) : manifestOnly ? (
              <div style={{
                height: 200, background: 'var(--panel-2)', borderRadius: 8,
                display: 'grid', placeItems: 'center', gap: 6,
                color: 'var(--muted)', fontSize: 'var(--fs-sm)', textAlign: 'center', padding: 16,
              }}>
                <div>This clip was built as a streaming manifest, not a single file.</div>
                <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)', fontFamily: 'ui-monospace,monospace' }}>
                  {d.master_key}
                </div>
                <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>
                  Cut it with Output set to “Downloadable file” to preview it here.
                </div>
              </div>
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
            {hasPicture === false && (
              <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginTop: 8 }}>
                Audio only — this clip was cut from a radio source.
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
                    <td>{p.platform}</td>
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
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!!busy || d.published}
              onClick={() => act(() => api.publishToPortal(d.id), 'pub')}>
              {d.published ? 'Already on the portal' : busy === 'pub' ? 'Publishing…' : 'Publish to the portal'}
            </button>
            {d.published && (
              <button className="btn ghost" style={{ marginLeft: 6 }} disabled={!!busy}
                onClick={() => act(() => api.patchVodAsset(d.id, { published: false }), 'unpub')}>
                Unpublish
              </button>
            )}
          </div>
        </div>
      )}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
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
          <h1>VOD Library</h1>
          <p>Everything that has been cut, where it came from, and where it went.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div className="err">{err}</div>}

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
            <tr><th>Title</th><th>Source</th><th>Length</th><th>Sources</th><th>Review</th><th>QC</th><th>Published</th><th>Cut</th><th /></tr>
          </thead>
          <tbody>
            {shown.map(a => {
              const x = a as any
              return (
                <Fragment key={a.id}>
                  <tr onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }}>
                    <td><b>{a.title || 'Untitled'}</b></td>
                    <td style={{ color: 'var(--muted)' }}>{x.source_name ?? '—'}</td>
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
                      {x.published
                        ? x.has_stale_publication
                          ? <span style={{ color: 'var(--warn,#fbbf24)' }}>yes, copy is old</span>
                          : <span style={{ color: 'var(--ok,#4ade80)' }}>yes</span>
                        : <span style={{ color: 'var(--faint)' }}>no</span>}
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
