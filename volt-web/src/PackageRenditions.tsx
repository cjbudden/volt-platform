// ============================================================================
//  PACKAGING CHANNEL INPUTS: the sent rendition ladder, one row per rendition.
//
//  A packaging channel does not encode: the customer sends every bitrate
//  already encoded, and each one is packaged 1:1 to the matching output. So
//  its "source" is a list of renditions (label, bitrate, protocol, URL), each
//  with an optional matching backup URL, and every URL can be checked before
//  saving. Used by New channel and by Channel settings, so both forms are the
//  same form (docs/UI_FEEDBACK.md, "Packaging and transcode settings").
//
//  SOURCE TYPES: every video protocol (HLS, DASH, SRT, RTMP, RTMPS, NDI,
//  ST 2110), each with its own settings. Compressed ones are packaged as they
//  arrive; NDI and ST 2110 are uncompressed, so their rendition is encoded once
//  at its own size and bitrate (shown on the row).
//
//  Fallback on source loss is one of:
//    none      no backup;
//    matching  a backup URL per rendition (stream_inputs role=backup, same label);
//    single    one backup source, transcoded up to every rendition bitrate
//              (stream_inputs role=backup with no label, fallback_transcode).
// ============================================================================
import type { HlsVariant, IngestProtocol } from './api'
import { HlsChoice, ProtocolSettings, SourceCheck, SourceInput, probeUrlFor, protoOf, sourceProblem, type SourceParams, type SourceValue } from './protocols'

export type PkgRow = {
  label: string; bitrateKbps: number; protocol: string; url: string; backupUrl: string
  /** RTMP / RTMPS stream key, and the backup's. */
  streamKey?: string; backupStreamKey?: string
  /** The protocol's own settings (SRT mode/latency/passphrase, NDI, ST 2110 SDP…), shared by the backup. */
  params?: SourceParams
}
export type PkgFallback = 'none' | 'matching' | 'single'
export type SourceOut = {
  role: 'primary' | 'backup'; protocol: string; ingestUrl: string; streamKey?: string
  renditionLabel?: string; renditionBitrateKbps?: number; params?: SourceParams
}

export const DEFAULT_PKG_ROWS: PkgRow[] = [
  { label: '1080p', bitrateKbps: 5000, protocol: 'hls', url: '', backupUrl: '' },
  { label: '720p', bitrateKbps: 2800, protocol: 'hls', url: '', backupUrl: '' },
  { label: '480p', bitrateKbps: 1200, protocol: 'hls', url: '', backupUrl: '' },
]

export const heightFromLabel = (l: string) => parseInt(l, 10) || 0
const variantHeight = (v: HlsVariant) => Number(v.resolution?.split('x')[1]) || 0
const variantKbps = (v: HlsVariant) => Math.round((v.averageBandwidth ?? v.bandwidth ?? 0) / 1000)
/** Picking a variant fills the row from what the master declares for it. */
function fromVariant(v: HlsVariant): Partial<PkgRow> {
  const h = variantHeight(v); const k = variantKbps(v)
  return { url: v.uri, ...(h ? { label: `${h}p` } : {}), ...(k ? { bitrateKbps: k } : {}) }
}

type StoredInput = {
  role: string; protocol: string; ingest_url: string | null; stream_key?: string | null
  rendition_label?: string | null; rendition_bitrate_kbps?: number | null
  params?: SourceParams | null
}

/** The address field's example for a row's protocol. */
function rowPlaceholder(r: PkgRow): string {
  const l = r.label || '1080p'
  switch (r.protocol) {
    case 'dash': return `https://…/${l}.mpd`
    case 'srt': return `srt://host:9000 (${l})`
    case 'rtmp': return 'rtmp://host/app'
    case 'rtmps': return 'rtmps://host:443/app'
    case 'ndi': return `MACHINE (${l})`
    case 'st2110': return '239.10.10.1:5000'
    default: return `https://…/${l}.m3u8`
  }
}

/** Read a packaging channel's stored inputs back into the form. */
export function pkgFromSources(sources: StoredInput[], ladder: { height: number; bitrate_kbps: number }[], fallbackTranscode: boolean) {
  const prim = sources.filter(s => s.role === 'primary')
  const backs = sources.filter(s => s.role === 'backup')
  const labelled = prim.filter(s => s.rendition_label)
  let rows: PkgRow[]
  if (labelled.length) {
    rows = labelled.map(s => {
      const b = backs.find(x => x.rendition_label === s.rendition_label)
      return {
        label: s.rendition_label!, bitrateKbps: Number(s.rendition_bitrate_kbps) || 0,
        protocol: (s.protocol || 'hls').toLowerCase(), url: s.ingest_url || '',
        backupUrl: b?.ingest_url || '', streamKey: s.stream_key || undefined, backupStreamKey: b?.stream_key || undefined,
        params: { ...(s.params ?? {}) },
      }
    })
  } else if (prim.length) {
    // An older packaging channel saved with one primary input: show it as the
    // top rendition, labelled from the ladder, so it can be split out.
    const top = [...ladder].sort((a, b) => b.height - a.height)[0]
    rows = prim.map((s, i) => ({
      label: i === 0 && top ? `${top.height}p` : '', bitrateKbps: i === 0 && top ? top.bitrate_kbps : 0,
      protocol: (s.protocol || 'hls').toLowerCase(), url: s.ingest_url || '', backupUrl: '',
      streamKey: s.stream_key || undefined, params: { ...(s.params ?? {}) },
    }))
  } else rows = DEFAULT_PKG_ROWS.map(r => ({ ...r }))
  const single = backs.find(b => !b.rendition_label)
  const mode: PkgFallback = backs.some(b => b.rendition_label) ? 'matching' : single ? 'single' : 'none'
  const fb: SourceValue = single
    ? { protocol: (single.protocol || 'hls').toLowerCase(), url: single.ingest_url || '', streamKey: single.stream_key || undefined, params: { ...(single.params ?? {}) } }
    : { protocol: 'hls', url: '' }
  return { rows, mode: mode === 'none' && fallbackTranscode && single ? 'single' as PkgFallback : mode, fb }
}

/** Turn the form into the API's sources[] and ladder. Returns an error to show, or the result. */
export function pkgToSources(rows: PkgRow[], mode: PkgFallback, fb: SourceValue, protocols?: IngestProtocol[]):
  { error: string } | { sources: SourceOut[]; outputLadder: { height: number; bitrateKbps: number }[]; fallbackTranscode: boolean } {
  const filled = rows.filter(r => r.url.trim() && r.label.trim())
  if (!filled.length) return { error: 'Add at least one rendition input (label + URL)' }
  const bad = filled.find(r => !heightFromLabel(r.label))
  if (bad) return { error: `"${bad.label}" is not a rendition label: start it with the height, e.g. 1080p` }
  const seen = new Set<string>()
  for (const r of filled) {
    const k = r.label.trim().toLowerCase()
    if (seen.has(k)) return { error: `Two renditions are labelled ${r.label.trim()}: each label must be different` }
    seen.add(k)
    if (!r.bitrateKbps) return { error: `Give ${r.label.trim()} its bitrate in kbps` }
    if (protocols) {
      const why = sourceProblem(protocols, { protocol: r.protocol, url: r.url, streamKey: r.streamKey, params: r.params })
      if (why) return { error: `${r.label.trim()}: ${why}` }
      if (mode === 'matching' && r.backupUrl.trim()) {
        const whyB = sourceProblem(protocols, { protocol: r.protocol, url: r.backupUrl, streamKey: r.backupStreamKey || r.streamKey, params: r.params })
        if (whyB) return { error: `${r.label.trim()} backup: ${whyB}` }
      }
    }
  }
  const sources: SourceOut[] = []
  const extra = (r: PkgRow, key?: string) => {
    const params = Object.fromEntries(Object.entries(r.params ?? {}).filter(([, v]) => String(v).trim() !== '')) as SourceParams
    return { ...(key?.trim() ? { streamKey: key.trim() } : {}), ...(Object.keys(params).length ? { params } : {}) }
  }
  for (const r of filled) sources.push({ role: 'primary', protocol: r.protocol, ingestUrl: r.url.trim(), renditionLabel: r.label.trim(), renditionBitrateKbps: r.bitrateKbps, ...extra(r, r.streamKey) })
  if (mode === 'matching') {
    for (const r of filled) if (r.backupUrl.trim()) sources.push({ role: 'backup', protocol: r.protocol, ingestUrl: r.backupUrl.trim(), renditionLabel: r.label.trim(), renditionBitrateKbps: r.bitrateKbps, ...extra(r, r.backupStreamKey || r.streamKey) })
  } else if (mode === 'single') {
    if (!fb.url.trim()) return { error: 'Add the single fallback source URL' }
    if (protocols) { const why = sourceProblem(protocols, fb); if (why) return { error: `Fallback source: ${why}` } }
    const fp = Object.fromEntries(Object.entries(fb.params ?? {}).filter(([, v]) => String(v).trim() !== '')) as SourceParams
    sources.push({ role: 'backup', protocol: fb.protocol, ingestUrl: fb.url.trim(), streamKey: fb.streamKey?.trim() || undefined, ...(Object.keys(fp).length ? { params: fp } : {}) })
  }
  const outputLadder = filled.map(r => ({ height: heightFromLabel(r.label), bitrateKbps: r.bitrateKbps })).sort((a, b) => b.height - a.height)
  return { sources, outputLadder, fallbackTranscode: mode === 'single' }
}

export function PackageRenditions({ protocols, rows, onRows, mode, onMode, fb, onFb, locked }: {
  protocols: IngestProtocol[]
  rows: PkgRow[]; onRows: (rows: PkgRow[]) => void
  mode: PkgFallback; onMode: (m: PkgFallback) => void
  fb: SourceValue; onFb: (v: SourceValue) => void
  /** Channel running: shown and copyable, not editable. */
  locked?: boolean
}) {
  const set = (i: number, p: Partial<PkgRow>) => { if (!locked) onRows(rows.map((r, j) => j === i ? { ...r, ...p } : r)) }
  const add = () => { if (!locked) onRows([...rows, { label: '', bitrateKbps: 1000, protocol: rows[rows.length - 1]?.protocol || 'hls', url: '', backupUrl: '' }]) }
  const del = (i: number) => { if (!locked) onRows(rows.filter((_, j) => j !== i)) }
  // Every video source type can feed a rendition (Icecast is radio only).
  const pkgProtocols = protocols.filter(p => p.packageFriendly && p.id !== 'icecast')
  // A master pasted into a row: make one rendition per video variant, highest first.
  const useAll = (vs: HlsVariant[]) => {
    if (locked) return
    const video = vs.filter(v => variantHeight(v)).sort((a, b) => variantKbps(b) - variantKbps(a))
    if (!video.length) return
    onRows(video.map(v => ({ label: `${variantHeight(v)}p`, bitrateKbps: variantKbps(v), protocol: 'hls', url: v.uri,
      backupUrl: rows.find(r => heightFromLabel(r.label) === variantHeight(v))?.backupUrl ?? '' })))
  }
  // A backup master: give each rendition the backup variant of the same height.
  const useAllBackup = (vs: HlsVariant[]) => {
    if (locked) return
    onRows(rows.map(r => { const m = vs.find(v => variantHeight(v) === heightFromLabel(r.label)); return m ? { ...r, backupUrl: m.uri } : r }))
  }
  return (
    <>
      <div className="sec-label">Sent renditions (your pre-encoded ladder)</div>
      <div className="field">
        {rows.map((r, i) => {
          const h = heightFromLabel(r.label) || undefined
          const pd = protoOf(protocols, r.protocol)
          const problem = r.url.trim() ? sourceProblem(protocols, { protocol: r.protocol, url: r.url, streamKey: r.streamKey, params: r.params }) : null
          return (
            <div key={i} className="pkg-row">
              <div className="pkg-row-h">
                <input className="inp" style={{ width: 90 }} value={r.label} onChange={e => set(i, { label: e.target.value })} placeholder="1080p" aria-label="Rendition label" />
                <div className="inp-unit">
                  <input className="inp" style={{ width: 110 }} value={r.bitrateKbps || ''} onChange={e => set(i, { bitrateKbps: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })} placeholder="5000" aria-label="Bitrate in kbps" />
                  <span>kbps</span>
                </div>
                <select className="inp" style={{ width: 110 }} value={r.protocol} onChange={e => {
                  const next = protoOf(protocols, e.target.value)
                  const fits = (u: string) => { try { return !next.urlPattern || !u.trim() || new RegExp(next.urlPattern, 'i').test(u.trim()) } catch { return true } }
                  set(i, { protocol: e.target.value, params: {}, url: fits(r.url) ? r.url : '', backupUrl: fits(r.backupUrl) ? r.backupUrl : '' })
                }} aria-label="Protocol">
                  {pkgProtocols.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                {rows.length > 1 && <button type="button" className="xbtn" style={{ marginLeft: 'auto' }} onClick={() => del(i)} title={`Remove ${r.label || 'this rendition'}`} disabled={locked}>✕</button>}
              </div>
              <input className="inp" value={r.url} onChange={e => set(i, { url: e.target.value })} placeholder={rowPlaceholder(r)} aria-label={`${r.label || 'Rendition'} ${pd.urlLabel}`} />
              {pd.streamKey.show && (
                <input className="inp" style={{ marginTop: 8 }} value={r.streamKey ?? ''} autoComplete="off" onChange={e => set(i, { streamKey: e.target.value })}
                  placeholder={`${pd.streamKey.label ?? 'Stream key'} for ${r.label || 'this rendition'}`} aria-label={`${r.label || 'Rendition'} stream key`} />
              )}
              <ProtocolSettings protocol={pd} params={r.params} onChange={params => set(i, { params })} compact />
              {pd.packaging === 'encode' && (
                <div className="hintxt">{pd.label} is uncompressed, so this rendition is encoded once to {r.label || 'its height'} at {r.bitrateKbps ? `${r.bitrateKbps} kbps` : 'its bitrate'} (not copied). Needs an ingest node on the {pd.id === 'ndi' ? 'NDI' : 'media'} network.</div>
              )}
              {problem && <div className="err" style={{ marginTop: 6 }}>{problem}</div>}
              <HlsChoice protocol={r.protocol} url={r.url} onPick={(url, v) => set(i, v ? fromVariant(v) : { url })}
                onUseAll={(vs) => useAll(vs)} useAllLabel="Use every variant as a rendition" />
              <SourceCheck protocol={r.protocol} url={probeUrlFor({ protocol: r.protocol, url: r.url, params: r.params })} expectHeight={h} expectKbps={r.bitrateKbps || undefined} />
              {mode === 'matching' && (
                <>
                  <input className="inp" style={{ marginTop: 10 }} value={r.backupUrl} onChange={e => set(i, { backupUrl: e.target.value })} placeholder={`backup ${rowPlaceholder(r)}`} aria-label={`${r.label || 'Rendition'} backup ${pd.urlLabel}`} />
                  {pd.streamKey.show && (
                    <input className="inp" style={{ marginTop: 8 }} value={r.backupStreamKey ?? ''} autoComplete="off" onChange={e => set(i, { backupStreamKey: e.target.value })}
                      placeholder={`Backup stream key (empty = same as primary)`} aria-label={`${r.label || 'Rendition'} backup stream key`} />
                  )}
                  <HlsChoice protocol={r.protocol} url={r.backupUrl} onPick={(url) => set(i, { backupUrl: url })}
                    onUseAll={(vs) => useAllBackup(vs)} useAllLabel="Match every rendition to its backup variant" />
                  <SourceCheck protocol={r.protocol} url={probeUrlFor({ protocol: r.protocol, url: r.backupUrl, params: r.params })} expectHeight={h} expectKbps={r.bitrateKbps || undefined} compact="Check backup" />
                </>
              )}
            </div>
          )
        })}
        <button type="button" className="chip" onClick={add} disabled={locked}>+ Add rendition</button>
        <div className="hintxt">Any source type: HLS, DASH, SRT, RTMP, NDI or ST 2110. Each rendition is packaged 1:1 to the matching output. The height is read from the label (e.g. 1080p). Paste a master playlist to choose the variant for a rendition, or to make one rendition per variant. Check each URL to see what it carries and its bitrate.</div>
      </div>

      <div className="sec-label">Fallback</div>
      <div className="field"><label>On source loss</label>
        <select className="inp" value={mode} onChange={e => { if (!locked) onMode(e.target.value as PkgFallback) }}>
          <option value="none">None</option>
          <option value="matching">Matching backup URLs (per rendition)</option>
          <option value="single">Single fallback source → transcode to all bitrates</option>
        </select>
      </div>
      {mode === 'single' && (
        <>
          <SourceInput protocols={protocols} value={fb} onChange={v => { if (!locked) onFb(v) }} label="Fallback source" />
          <div className="hintxt" style={{ marginTop: -6 }}>Transcoded up to every rendition bitrate so all outputs stay continuous.</div>
        </>
      )}
    </>
  )
}
