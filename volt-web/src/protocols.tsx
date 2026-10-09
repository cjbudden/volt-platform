// Protocol-aware source input. The registry is fetched once from the API
// (GET /api/ingest-protocols — the single source of truth) and cached; the source
// form's label / placeholder / example / stream-key field then change to suit the
// selected protocol. A tiny built-in fallback keeps the form usable if the fetch
// is momentarily unavailable. See docs/DESIGN_forms_and_fields.md.
import { useEffect, useState } from 'react'
import { api, type IngestProtocol, type SourceProbe } from './api'

const FALLBACK: IngestProtocol[] = [
  { id: 'srt', label: 'SRT', ingest: 'push', urlLabel: 'SRT URL', urlPlaceholder: 'srt://host:9000?streamid=…', urlExample: 'srt://ingest.volt.example:9000?streamid=live&latency=200', urlPattern: '^srt://', streamKey: { show: false }, hint: 'streamid selects the channel; add latency/passphrase as query params.', packageFriendly: false },
  { id: 'rtmp', label: 'RTMP', ingest: 'push', urlLabel: 'RTMP URL', urlPlaceholder: 'rtmp://host/app', urlExample: 'rtmp://ingest.volt.example/live', urlPattern: '^rtmp://', streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123' }, hint: 'URL + stream key, like OBS.', packageFriendly: false },
  { id: 'rtmps', label: 'RTMPS', ingest: 'push', urlLabel: 'RTMPS URL', urlPlaceholder: 'rtmps://host:443/app', urlExample: 'rtmps://ingest.volt.example:443/live', urlPattern: '^rtmps://', streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123' }, hint: 'TLS RTMP; URL + stream key.', packageFriendly: false },
  { id: 'hls', label: 'HLS', ingest: 'pull', urlLabel: 'HLS manifest URL', urlPlaceholder: 'https://…/master.m3u8', urlExample: 'https://cdn.example.com/live/master.m3u8', urlPattern: '^https?://.+\\.m3u8', streamKey: { show: false }, hint: 'We pull this playlist.', packageFriendly: true },
  { id: 'dash', label: 'DASH', ingest: 'pull', urlLabel: 'DASH manifest URL', urlPlaceholder: 'https://…/manifest.mpd', urlExample: 'https://cdn.example.com/live/manifest.mpd', urlPattern: '^https?://.+\\.mpd', streamKey: { show: false }, hint: 'We pull this MPD.', packageFriendly: true },
  { id: 'ndi', label: 'NDI', ingest: 'pull', urlLabel: 'NDI source name', urlPlaceholder: 'STUDIO-PC (Camera 1)', urlExample: 'STUDIO-PC (Camera 1)', streamKey: { show: false }, hint: 'NDI source name on the local network.', packageFriendly: false },
  { id: 'st2110', label: 'ST 2110', ingest: 'pull', urlLabel: 'ST 2110 stream', urlPlaceholder: '239.0.0.1:5000', urlExample: '239.0.0.1:5000', streamKey: { show: false }, hint: 'SMPTE ST 2110 multicast; needs a capable ingest node.', packageFriendly: false },
]

let cache: IngestProtocol[] | null = null
let inflight: Promise<IngestProtocol[]> | null = null

export function useProtocols(): IngestProtocol[] {
  const [protocols, setProtocols] = useState<IngestProtocol[]>(cache ?? FALLBACK)
  useEffect(() => {
    if (cache) { setProtocols(cache); return }
    inflight = inflight ?? api.ingestProtocols().then(r => (cache = r.protocols?.length ? r.protocols : FALLBACK))
    inflight.then(setProtocols).catch(() => setProtocols(FALLBACK))
  }, [])
  return protocols
}

export function protoOf(protocols: IngestProtocol[], id: string): IngestProtocol {
  return protocols.find(p => p.id === id) ?? protocols[0] ?? FALLBACK[0]
}

export interface SourceValue { protocol: string; url: string; streamKey?: string }

/** Full protocol-aware source sub-form: protocol picker + URL (protocol placeholder)
 *  + optional stream-key field + example/hint that track the protocol. */
export function SourceInput({ protocols, value, onChange, label, packageOnly, validate = true, ladderTop }: {
  protocols: IngestProtocol[]
  value: SourceValue
  onChange: (v: SourceValue) => void
  label?: string
  packageOnly?: boolean   // restrict to pull/manifest protocols for package inputs
  /** Show the Check source control (off where the page has its own probe, e.g. radio). */
  validate?: boolean
  /** Height of the output ladder's top rung, to warn when it would upscale the source. */
  ladderTop?: number
}) {
  const list = packageOnly ? protocols.filter(p => p.packageFriendly) : protocols
  const d = protoOf(protocols, value.protocol)
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <div style={{ display: 'flex', gap: 8 }}>
        <select className="inp" style={{ width: 120 }} value={value.protocol} onChange={e => onChange({ ...value, protocol: e.target.value })}>
          {(list.length ? list : protocols).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input className="inp" value={value.url} onChange={e => onChange({ ...value, url: e.target.value })} placeholder={d.urlPlaceholder} />
      </div>
      {d.streamKey.show && (
        <input className="inp" style={{ marginTop: 8 }} value={value.streamKey ?? ''} onChange={e => onChange({ ...value, streamKey: e.target.value })} placeholder={d.streamKey.placeholder ?? 'stream key'} />
      )}
      <div className="hintxt">{d.hint} e.g. <span style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--muted)' }}>{d.urlExample}</span></div>
      {validate && <SourceCheck protocol={value.protocol} url={value.url} ladderTop={ladderTop} />}
    </div>
  )
}

/* ============================================================================
   CHECK SOURCE. Probes the source from the control plane and says what it is
   actually receiving: container, video, every audio track, and anything else
   the stream carries (timed metadata, subtitles, data). A push source (SRT
   listener, RTMP) has nothing to dial yet, and the answer says so rather than
   reporting it unreachable.

   The result belongs to the URL it was taken from: edit the URL and the old
   result goes, so a stale "1080p, reachable" can never sit under a new address.
   ========================================================================== */
const kbpsText = (n?: number | null) => n ? (n >= 1000 ? `${(n / 1000).toFixed(1)} Mbps` : `${n} kbps`) : null

export function SourceCheck({ protocol, url, ladderTop }: { protocol: string; url: string; ladderTop?: number }) {
  const [res, setRes] = useState<{ for: string; probe: SourceProbe } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const key = `${protocol}|${url.trim()}`
  const shown = res && res.for === key ? res.probe : null
  useEffect(() => { setErr('') }, [key])

  async function run() {
    setErr(''); setBusy(true)
    try { setRes({ for: key, probe: await api.probeSource(url.trim(), protocol) }) }
    catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  const v = shown?.video
  const upscale = v?.height && ladderTop && ladderTop > v.height ? ladderTop : null
  return (
    <div className="src-check">
      <button type="button" className="btn ghost" disabled={!url.trim() || busy} onClick={run}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
        {busy ? 'Checking…' : 'Check source'}
      </button>
      {err && <div className="err">{err}</div>}
      {shown && (
        <div className="src-check-out" role="status">
          {shown.error && <div className="err" style={{ marginTop: 0 }}>{shown.error}</div>}
          {shown.note && <div className="hintxt" style={{ marginTop: 0 }}>{shown.note}</div>}
          {shown.reachable && (
            <>
              <div className="src-check-head">
                <span className="src-dot ok" aria-hidden="true" /> Receiving
                {shown.container?.format && <span className="src-muted"> · {shown.container.format.split(',')[0]}</span>}
                {kbpsText(shown.container?.bitrate_kbps) && <span className="src-muted"> · {kbpsText(shown.container?.bitrate_kbps)}</span>}
              </div>
              <div className="kv"><span className="k">Video</span><span className="v">
                {v ? [v.codec?.toUpperCase(), v.width && v.height ? `${v.width}×${v.height}` : null, v.fps ? `${v.fps} fps` : null, kbpsText(v.bitrate_kbps), v.profile].filter(Boolean).join(' · ') : 'none (audio only)'}
              </span></div>
              {(shown.audio ?? []).length === 0
                ? <div className="kv"><span className="k">Audio</span><span className="v">none</span></div>
                : (shown.audio ?? []).map((a, i) => (
                  <div className="kv" key={i}><span className="k">Audio {i + 1}</span><span className="v">
                    {[a.codec?.toUpperCase(), a.channels ? `${a.channels} ch` : null, a.sample_rate ? `${a.sample_rate / 1000} kHz` : null, kbpsText(a.bitrate_kbps), a.language && a.language !== 'und' ? a.language : null].filter(Boolean).join(' · ')}
                  </span></div>
                ))}
              {(shown.other ?? []).map((o, i) => (
                <div className="kv" key={'o' + i}><span className="k">{o.kind === 'subtitle' ? 'Subtitles' : o.kind === 'data' ? 'Data' : o.kind}</span><span className="v">
                  {[o.note ?? o.codec, o.language].filter(Boolean).join(' · ')}
                </span></div>
              ))}
              {upscale && <div className="hintxt" style={{ color: 'var(--warn)' }}>The output ladder's top rung is {upscale}p but the source is {v!.height}p, so that rung would be upscaled. Lower it to {v!.height}p or below.</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
