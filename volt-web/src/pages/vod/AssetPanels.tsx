// ============================================================================
//  THE ASSET PAGE'S LIBRARY PANELS.
//
//  TargetMetadataPanel: the target fields of the asset's content type, which
//  are filled, which are required, and where a value came from when it was
//  not typed ("From the guide: Harbour, 18:00"). Fill from EPG opens a
//  preview of what the matching programme would set; nothing is written until
//  the operator applies, and a value somebody already typed is replaced only
//  when its own "Replace" box is ticked.
//
//  EncodePanel: how the asset was encoded. A value the platform stores is
//  shown plainly; one derived from the encoder's contract is marked
//  "derived"; anything nobody records says "Not recorded" and is listed
//  under the gaps, so a guess is never shown as a fact.
// ============================================================================
import { useEffect, useState } from 'react'
import { Notice, useNotify } from '../../notices'
import { LibIcon } from './icons'
import { libraryApi, type DownloadFile, type EncodeDetails, type EpgPreview, type Prov, type TargetMetadata } from './libraryApi'
import { useAccess } from '../../access'

const show = (v: any): string => {
  if (v == null || v === '') return ''
  if (Array.isArray(v)) return v.map(show).join(', ')
  if (typeof v === 'object') return v.name ?? v.id ?? JSON.stringify(v)
  return String(v)
}
const filled = (v: any) => !(v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const dayTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function TargetMetadataPanel({ asset, reloadKey, onChanged }: { asset: any; reloadKey: number; onChanged: () => void }) {
  const [t, setT] = useState<TargetMetadata | null>(null)
  const [err, setErr] = useState('')
  const [fillOpen, setFillOpen] = useState(false)
  useEffect(() => {
    let gone = false
    libraryApi.targetMetadata(asset.id).then((x) => { if (!gone) { setT(x); setErr('') } }).catch((e) => { if (!gone) setErr(e.message) })
    return () => { gone = true }
  }, [asset.id, reloadKey])
  if (err) return <Notice kind="error" variant="compact" title="Couldn't load the target metadata." message={err} />
  if (!t) return <div className="loading">Loading target metadata…</div>
  const c = t.completeness
  const m = asset.metadata ?? {}
  const noGuide = asset.source_kind === 'upload' || asset.source_kind === 'watchfolder' || (!asset.channel_id && !asset.event_id)
  return (
    <section className="lib-target" aria-label="Target metadata">
      <div className="lib-target-h">
        <div>
          <div className="sec-label" style={{ margin: 0 }}>Target metadata</div>
          <div className="lib-target-type">
            {t.type ? <>{t.type.name}{t.type.schemaOrgType && <span className="lib-so">schema.org {t.type.schemaOrgType}</span>}</> : 'No content type. Choose one below.'}
          </div>
        </div>
        {c.pct != null && (
          <div className={`lib-target-score${c.missingRequired.length ? ' warn' : c.pct === 100 ? ' done' : ''}`}>
            <span className="lib-bar lib-bar-l" aria-hidden="true"><span style={{ width: `${c.pct}%` }} /></span>
            <b>{c.pct}%</b><span>{c.filled} of {c.total}</span>
          </div>
        )}
        <div className="flex-1" />
        <button type="button" className="btn ghost" disabled={noGuide || !t.type} onClick={() => setFillOpen(true)}
          title={noGuide ? 'Uploaded files have no guide slot to fill from' : !t.type ? 'Choose a content type first' : 'Preview what the guide programme would fill'}>
          {LibIcon.epg}Fill from EPG
        </button>
      </div>
      {c.missingRequired.length > 0 && (
        <div className="lib-target-warn" role="status">{LibIcon.alert}Required for this type and still empty: {c.missingRequired.map((k) => t.fields.find((f) => f.key === k)?.label ?? k).join(', ')}.</div>
      )}
      {t.fields.length > 0 && (
        <ul className="lib-target-list">
          {t.fields.map((f) => {
            const v = m[f.key]
            const isFilled = filled(v)
            const p = t.provenance[f.key]
            return (
              <li key={f.key} className={isFilled ? 'is-filled' : f.required ? 'is-missing' : ''}>
                <span className="lib-target-ic" aria-hidden="true">{isFilled ? LibIcon.check : f.required ? LibIcon.alert : LibIcon.empty}</span>
                <span className="lib-target-l">{f.label}{f.required && <span className="lib-req">Required</span>}</span>
                <span className="lib-target-v" title={show(v)}>{isFilled ? show(v) : <span className="lib-faint">Empty</span>}</span>
                {p?.source === 'epg' && (
                  <span className="lib-prov" title={`Filled from the guide programme "${p.programmeTitle ?? ''}"${p.at ? ` on ${new Date(p.at).toLocaleString()}` : ''}${p.by ? ` by ${p.by}` : ''}`}>
                    {LibIcon.epg}EPG
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {t.provenance.title?.source === 'epg' && <div className="lib-faint lib-small">The asset title was filled from the guide programme "{t.provenance.title.programmeTitle}".</div>}
      {c.notOnType.length > 0 && (
        <div className="lib-faint lib-small">This account's copy of the type has no {c.notOnType.join(', ')} field. Add it under Content Types to make it part of the record.</div>
      )}
      {fillOpen && <EpgFillDialog asset={asset} onClose={() => setFillOpen(false)} onApplied={() => { setFillOpen(false); onChanged() }} />}
    </section>
  )
}

function EpgFillDialog({ asset, onClose, onApplied }: { asset: any; onClose: () => void; onApplied: () => void }) {
  const [pid, setPid] = useState<string | null>(null)
  const [p, setP] = useState<EpgPreview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [replace, setReplace] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState(false)
  const [applyType, setApplyType] = useState(false)
  const notify = useNotify()
  useEffect(() => {
    let gone = false
    setP(null)
    libraryApi.epgPreview(asset.id, pid).then((x) => {
      if (gone) return
      setP(x); setErr('')
      // Empty fields are ticked; anything already filled is not, and needs its own Replace.
      setPick(new Set(x.suggestions.filter((s) => s.action === 'fill').map((s) => s.field)))
      setReplace(new Set())
      setTitle(x.titleSuggestion?.action === 'fill')
      setApplyType(false)
    }).catch((e) => { if (!gone) setErr(e.message) })
    return () => { gone = true }
  }, [asset.id, pid])
  const toggle = (set: Set<string>, k: string, f: (s: Set<string>) => void) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); f(n) }
  async function apply() {
    if (!p?.programme) return
    setBusy(true)
    try {
      const fields = [...pick, ...replace]
      const r = await libraryApi.epgApply(asset.id, {
        programmeId: p.programme.id, fields: applyType ? undefined : fields, overwrite: [...replace, ...(title && p.titleSuggestion?.action === 'conflict' ? ['title'] : [])],
        applyType, title,
      })
      notify({ kind: 'ok', message: r.applied.length || r.titleChanged || r.typeChanged ? `Filled ${r.applied.length} field${r.applied.length === 1 ? '' : 's'} from "${p.programme.title}".` : (r.reason ?? 'Nothing changed.') })
      onApplied()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const nothing = p && !p.programme
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="drawer lib-drawer-wide" role="dialog" aria-modal="true" aria-labelledby="epg-fill-t" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="drawer-h">
          <span className="t" id="epg-fill-t">{LibIcon.epg} Fill from EPG</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">{LibIcon.close}</button>
        </div>
        <div className="drawer-b">
          {err && <Notice kind="error" variant="compact" message={err} />}
          {!p && !err && <div className="loading">Looking up the guide…</div>}
          {nothing && <Notice kind="info" variant="compact" title="No programme to fill from." message={p!.match.reason ?? ''} />}
          {p && p.match.candidates.length > 0 && (
            <div className="field">
              <label htmlFor="epg-prog">Programme</label>
              <select id="epg-prog" className="inp" value={p.programme?.id ?? ''} onChange={(e) => setPid(e.target.value || null)}>
                {p.match.candidates.map((c) => (
                  <option key={c.programmeId} value={c.programmeId}>
                    {c.title} · {dayTime(c.startsAt)} to {hhmm(c.endsAt)} · covers {Math.round(c.assetCoverage * 100)}% of the clip{c.linked ? ' · made this clip' : ''}
                  </option>
                ))}
              </select>
              {!p.match.confident && p.match.reason && <div className="lib-hint warn">{LibIcon.alert}{p.match.reason}</div>}
            </div>
          )}
          {p?.programme && (
            <>
              {p.suggestedType && (
                <label className="lib-sugg-type">
                  <input type="checkbox" checked={applyType} onChange={() => setApplyType(!applyType)} />
                  <span>Change the content type to <b>{p.suggestedType.name}</b>. The guide describes this as one.
                    {p.suggestedType.dropsFields.length > 0 && <span className="lib-hint warn">Values with no place on that type are not carried over: {p.suggestedType.dropsFields.join(', ')}.</span>}
                    {applyType && <span className="lib-hint">Empty fields of the new type are filled. Fields you have typed are kept.</span>}
                  </span>
                </label>
              )}
              <table className="lib-sugg">
                <thead><tr><th scope="col">Use</th><th scope="col">Field</th><th scope="col">From the guide</th><th scope="col">Now</th></tr></thead>
                <tbody>
                  {p.titleSuggestion && p.titleSuggestion.action !== 'same' && (
                    <tr>
                      <td><input type="checkbox" checked={title} onChange={() => setTitle(!title)} aria-label="Use the guide title as the asset title" /></td>
                      <td>Asset title</td>
                      <td>{p.titleSuggestion.value}</td>
                      <td className="lib-faint">{p.titleSuggestion.current || 'Empty'}{p.titleSuggestion.action === 'conflict' && title && <span className="lib-replace">Replaces it</span>}</td>
                    </tr>
                  )}
                  {p.suggestions.map((s) => {
                    const conflict = s.action === 'conflict'
                    const on = conflict ? replace.has(s.field) : pick.has(s.field)
                    return (
                      <tr key={s.field} className={s.action === 'same' ? 'same' : ''}>
                        <td>
                          {s.action === 'same'
                            ? <span className="lib-faint" title="Already this value">{LibIcon.check}</span>
                            : <input type="checkbox" checked={on} disabled={applyType}
                                onChange={() => conflict ? toggle(replace, s.field, setReplace) : toggle(pick, s.field, setPick)}
                                aria-label={conflict ? `Replace ${s.label}` : `Fill ${s.label}`} />}
                        </td>
                        <td>{s.label}{s.required && <span className="lib-req">Required</span>}</td>
                        <td>{show(s.value)}</td>
                        <td className="lib-faint">{s.action === 'fill' ? 'Empty' : show(s.current)}{conflict && on && <span className="lib-replace">Replaces it</span>}</td>
                      </tr>
                    )
                  })}
                  {p.suggestions.length === 0 && !p.titleSuggestion && <tr><td colSpan={4} className="lib-faint">The programme has nothing for this type's fields.</td></tr>}
                </tbody>
              </table>
              <div className="lib-faint lib-small">Source: guide programme "{p.programme.title}", {dayTime(p.programme.startsAt)} to {hhmm(p.programme.endsAt)}. Each value applied records this programme and appears in the audit log.</div>
            </>
          )}
        </div>
        <div className="drawer-f">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !p?.programme || (!pick.size && !replace.size && !title && !applyType)} onClick={apply}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

const Mark = ({ s }: { s: Prov }) => s === 'derived'
  ? <span className="lib-derived" title="From the encoder's fixed settings, not recorded for this asset">derived</span> : null
const NR = () => <span className="lib-faint">Not recorded</span>
const kbps = (k: number | null) => (k == null ? '' : k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)} Mb/s` : `${k} kb/s`)

/**
 * DOWNLOADS: the asset's files, for people whose role has Downloads.
 * Not shown at all without Downloads: view; buttons only with operate. Each
 * click asks the server for a five-minute link (and is audited), so the file
 * never needs a public address of its own (modules/downloads.ts).
 */
export function DownloadFiles({ id, compact = false }: { id: string; compact?: boolean }) {
  const { can } = useAccess()
  const notify = useNotify()
  const [files, setFiles] = useState<DownloadFile[] | null>(null)
  const [busy, setBusy] = useState('')
  const canSee = can('downloads', 'view')
  const canGet = can('downloads', 'operate')
  useEffect(() => {
    if (!canSee) return
    let gone = false
    libraryApi.downloads(id).then((r) => { if (!gone) setFiles(r.files) }).catch(() => { if (!gone) setFiles([]) })
    return () => { gone = true }
  }, [id, canSee])
  if (!canSee || !files) return null
  const get = async (f: DownloadFile) => {
    setBusy(f.format)
    try {
      const r = await libraryApi.downloadLink(id, f.format)
      const a = document.createElement('a')
      a.href = r.url; a.download = r.filename; a.rel = 'noopener'
      document.body.appendChild(a); a.click(); a.remove()
      notify({ id: 'download', kind: 'ok', message: `Downloading ${r.filename}.` })
    } catch (e: any) {
      notify({ id: 'download', kind: 'error', title: 'The download did not start.', message: e.message })
    } finally { setBusy('') }
  }
  const mb = (b: number | null) => b == null ? '' : b > 1e9 ? ` · ${(b / 1e9).toFixed(1)} GB` : ` · ${(b / 1e6).toFixed(1)} MB`
  if (compact) {
    return <>{files.map((f) => (
      <button key={f.format} type="button" className="btn ghost" style={{ marginLeft: 6 }} disabled={!canGet || !!busy}
        title={canGet ? f.filename : 'Your role does not include downloading'} onClick={() => get(f)}>
        {busy === f.format ? 'Preparing…' : `Download ${f.format.toUpperCase()}`}
      </button>))}</>
  }
  return (
    <>
      <div className="sec-label">Download</div>
      {files.length === 0
        ? <div className="lib-faint lib-small">No downloadable file yet. Ask for MP4, MP3 or AAC under Deliveries, then download it here.</div>
        : (
          <table className="lib-rend lib-deliv">
            <thead><tr><th scope="col">File</th><th scope="col">Name</th><th /></tr></thead>
            <tbody>{files.map((f) => (
              <tr key={f.format}>
                <td>{f.label}</td>
                <td className="lib-faint"><span className="mono">{f.filename}</span>{mb(f.bytes)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="btn ghost sm" disabled={!canGet || !!busy} onClick={() => get(f)}
                    title={canGet ? 'Download this file' : 'Your role lets you see the files, not download them'}>
                    {busy === f.format ? 'Preparing…' : 'Download'}
                  </button>
                </td>
              </tr>))}</tbody>
          </table>
        )}
      {!canGet && files.length > 0 && <div className="lib-faint lib-small">Downloading needs the Downloads permission in your role.</div>}
    </>
  )
}

export function EncodePanel({ id }: { id: string }) {
  const [e, setE] = useState<EncodeDetails | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let gone = false
    libraryApi.encode(id).then((x) => { if (!gone) setE(x) }).catch((x) => { if (!gone) setErr(x.message) })
    return () => { gone = true }
  }, [id])
  if (err) return <Notice kind="error" variant="compact" title="Couldn't load the encode settings." message={err} />
  if (!e) return <div className="loading">Loading encode settings…</div>
  const Row = ({ k, children }: { k: string; children: React.ReactNode }) => <tr><th scope="row">{k}</th><td>{children}</td></tr>
  const STATE: Record<string, { t: string; c: string }> = { ready: { t: 'Ready', c: 'ok' }, making: { t: 'Being made', c: 'busy' }, failed: { t: 'Requested, not made', c: 'bad' }, not_requested: { t: 'Not requested', c: 'off' } }
  const Deliveries = () => e.deliveries?.length ? (
    <>
      <div className="sec-label">Deliveries</div>
      <table className="lib-rend lib-deliv">
        <thead><tr><th scope="col">Format</th><th scope="col">What it is</th><th scope="col">State</th></tr></thead>
        <tbody>{e.deliveries.map((d) => (
          <tr key={d.format} className={d.state === 'not_requested' ? 'off' : ''}>
            <td>{d.label}</td>
            <td className="lib-faint">{d.detail ?? '—'}</td>
            <td><span className={`lib-deliv-st ${STATE[d.state].c}`}>{STATE[d.state].t}</span></td>
          </tr>))}</tbody>
      </table>
    </>
  ) : null

  // Recorded facts that are not gaps: which source track was encoded, what was not carried.
  const Notes = () => e.notes?.length ? (
    <ul className="lib-notes lib-faint lib-small">{e.notes.map((n, i) => <li key={i}>{LibIcon.info}{n}</li>)}</ul>
  ) : null
  const track = (a: { codec: string | null; channels: number | null; sampleRate: number | null; bitrateKbps: number | null; language: string | null }) =>
    [a.codec ?? 'unknown codec', a.channels === 2 ? 'stereo' : a.channels === 1 ? 'mono' : a.channels ? `${a.channels} ch` : null,
      a.bitrateKbps ? `${a.bitrateKbps} kb/s` : null, a.sampleRate ? `${a.sampleRate / 1000} kHz` : null, a.language ?? 'no language set'].filter(Boolean).join(' · ')

  // AUDIO (a radio recording, a song, an audio file): what the sound was encoded as and how it is
  // delivered. No picture, no video renditions.
  if (e.kind === 'audio') {
    const ae = e.audioEncode
    return (
      <div className="lib-encode">
        <div className="lib-encode-sum">{LibIcon.audio}<b>{e.summary.label || 'Audio only'}</b></div>
        <div className="lib-encode-grid">
          <div>
            <div className="sec-label">Audio encode <Mark s={ae?.source ?? 'unknown'} /></div>
            <table className="lib-kv"><tbody>
              <Row k="Codec">{ae?.codec ?? <NR />}</Row>
              <Row k="Bitrate">{ae?.bitrateKbps ? `${ae.bitrateKbps} kb/s` : <NR />}</Row>
              <Row k="Sound">{[ae?.channels === 2 ? 'Stereo' : ae?.channels === 1 ? 'Mono' : ae?.channels ? `${ae.channels} channels` : null, ae?.sampleRate ? `${ae.sampleRate / 1000} kHz` : null].filter(Boolean).join(' · ') || <NR />}</Row>
              <Row k="Segment duration">{e.segmentSeconds.value != null ? `${e.segmentSeconds.value} s` : <NR />}</Row>
              <Row k="Container">{e.container.value ?? <NR />}</Row>
            </tbody></table>
            {ae?.note && <div className="lib-faint lib-small">{ae.note}</div>}
          </div>
          <div>
            <div className="sec-label">Source</div>
            <table className="lib-kv"><tbody>
              <Row k="From">{e.source.origin.replace('the channel or event renditions', 'the station\'s audio')}</Row>
              {e.source.filename && <Row k="File"><span className="mono">{e.source.filename}</span></Row>}
              {e.source.durationMs != null && <Row k="Length">{Math.floor(e.source.durationMs / 60000)}:{String(Math.round(e.source.durationMs / 1000) % 60).padStart(2, '0')}</Row>}
              {e.source.bytes != null && <Row k="Size">{(e.source.bytes / 1e6).toFixed(1)} MB</Row>}
            </tbody></table>
          </div>
        </div>
        <Deliveries />
        <DownloadFiles id={id} />
        {e.captions.value.length > 0 && (<>
          <div className="sec-label">Transcripts and subtitles</div>
          <ul className="lib-tracks">{e.captions.value.map((c, i) => <li key={i}>{c.kind === 'captions' ? 'Transcript' : 'Subtitles'} · <span className="mono">{c.language}</span> · {c.source}</li>)}</ul>
        </>)}
        <Notes />
        {e.gaps.length > 0 && (
          <details className="lib-gaps">
            <summary>{LibIcon.alert}What is not recorded ({e.gaps.length})</summary>
            <ul>{e.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
          </details>
        )}
      </div>
    )
  }

  return (
    <div className="lib-encode">
      <div className="lib-encode-sum">{LibIcon.encode}<b>{e.summary.label || 'Encode not known'}</b></div>
      <div className="lib-encode-grid">
        <div>
          <div className="sec-label">Workflow</div>
          <table className="lib-kv"><tbody>
            <Row k="Workflow">{e.workflow.value === 'package_only' ? 'Package only (source ladder passed through)' : e.workflow.value === 'transcode' ? 'Transcode' : <NR />}</Row>
            <Row k="Ladder profile">{e.ladder.value ?? <NR />}</Row>
            <Row k="Segment duration">{e.segmentSeconds.value != null ? `${e.segmentSeconds.value} s` : <NR />}</Row>
            <Row k="Packaging">{e.packaging.value.length ? e.packaging.value.map((x) => <span key={x} className="tag proto lib-proto">{x}</span>) : <NR />}<Mark s={e.packaging.source} /></Row>
            <Row k="Container">{e.container.value ?? <NR />}<Mark s={e.container.source} /></Row>
            <Row k="DRM">{e.drm.source === 'unknown' ? <NR /> : e.drm.value.length ? e.drm.value.join(', ') : 'None (in the clear)'}<Mark s={e.drm.source} /></Row>
          </tbody></table>
        </div>
        <div>
          <div className="sec-label">Source / mezzanine</div>
          <table className="lib-kv"><tbody>
            <Row k="From">{e.source.origin}</Row>
            {e.source.filename && <Row k="File"><span className="mono">{e.source.filename}</span></Row>}
            <Row k="Picture">{e.source.width && e.source.height ? `${e.source.width}×${e.source.height}` : e.source.height ? `${e.source.height}p` : <NR />}{e.source.fps ? ` · ${e.source.fps} fps` : ''}</Row>
            {e.source.videoCodec && <Row k="Video codec">{e.source.videoCodec}{e.source.videoProfile ? ` · ${e.source.videoProfile}` : ''}</Row>}
            {e.source.audioTracks ? (
              <Row k="Audio in source">{e.source.audioTracks.length ? <ul className="lib-tracks">{e.source.audioTracks.map((a, i) => <li key={i}>{track(a)}</li>)}</ul> : 'None'}</Row>
            ) : <Row k="Audio in source">{e.source.hasAudio == null ? <NR /> : e.source.hasAudio ? 'Yes' : 'No'}</Row>}
            {e.source.subtitleTracks && <Row k="Subtitles in source">{e.source.subtitleTracks.length ? e.source.subtitleTracks.map((t) => `${t.codec ?? 'unknown'} · ${t.language ?? 'no language set'}`).join(', ') : 'None'}</Row>}
            {e.source.bytes != null && <Row k="Size">{(e.source.bytes / 1e9).toFixed(2)} GB</Row>}
          </tbody></table>
        </div>
      </div>
      <div className="sec-label">Renditions</div>
      {e.renditions.value.length ? (
        <table className="lib-rend">
          <thead><tr><th scope="col">Resolution</th><th scope="col">Bitrate</th><th scope="col">Codec</th><th scope="col">Profile</th><th scope="col">Frame rate</th></tr></thead>
          <tbody>
            {e.renditions.value.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.width ? `${r.width}×${r.height}` : `${r.height}p`}</td>
                <td className="mono">{kbps(r.bitrateKbps)}</td>
                <td>{r.codec}</td>
                <td>{r.profile ? `${r.profile}${r.level ? ` · level ${r.level}` : ''}` : <NR />}</td>
                <td className="mono">{r.fps ? `${r.fps}p` : <NR />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <NR />}
      {e.dropped.length > 0 && <div className="lib-faint lib-small">Not encoded: {e.dropped.map((d) => `${d.height}p (${d.why})`).join(', ')}.</div>}
      <Deliveries />
      <DownloadFiles id={id} />
      <div className="lib-encode-grid">
        <div>
          <div className="sec-label">Audio tracks <Mark s={e.audio.source} /></div>
          {e.audio.value.length ? (
            <ul className="lib-tracks">{e.audio.value.map((a, i) => <li key={i}>{track(a)}</li>)}</ul>
          ) : e.audio.source === 'stored' ? <span>No audio</span> : <NR />}
        </div>
        <div>
          <div className="sec-label">Captions and subtitles</div>
          {e.captions.value.length ? (
            <ul className="lib-tracks">{e.captions.value.map((c, i) => <li key={i}>{c.kind === 'captions' ? 'Captions' : 'Subtitles'} · <span className="mono">{c.language}</span> · {c.source}</li>)}</ul>
          ) : e.captions.source === 'stored' ? <span>None</span> : <NR />}
        </div>
      </div>
      <Notes />
      {e.gaps.length > 0 && (
        <details className="lib-gaps">
          <summary>{LibIcon.alert}What is not recorded ({e.gaps.length})</summary>
          <ul>{e.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
