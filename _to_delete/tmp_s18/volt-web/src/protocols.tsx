// Protocol-aware source input. The registry is fetched once from the API
// (GET /api/ingest-protocols — the single source of truth) and cached; the source
// form's label / placeholder / example / stream-key field then change to suit the
// selected protocol. A tiny built-in fallback keeps the form usable if the fetch
// is momentarily unavailable. See docs/DESIGN_forms_and_fields.md.
import { useEffect, useState } from 'react'
import { api, type IngestProtocol } from './api'

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
export function SourceInput({ protocols, value, onChange, label, packageOnly }: {
  protocols: IngestProtocol[]
  value: SourceValue
  onChange: (v: SourceValue) => void
  label?: string
  packageOnly?: boolean   // restrict to pull/manifest protocols for package inputs
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
    </div>
  )
}
