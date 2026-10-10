// Protocol-aware source input. The registry is fetched once from the API
// (GET /api/ingest-protocols — the single source of truth) and cached; the source
// form's label / placeholder / example / stream-key field then change to suit the
// selected protocol. A tiny built-in fallback keeps the form usable if the fetch
// is momentarily unavailable. See docs/DESIGN_forms_and_fields.md.
import { useEffect, useState } from 'react'
import { api, type IngestProtocol, type SourceProbe, type HlsInspection, type HlsVariant } from './api'

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
      <HlsChoice protocol={value.protocol} url={value.url} onPick={(url) => onChange({ ...value, url })} />
      {validate && <SourceCheck protocol={value.protocol} url={value.url} ladderTop={ladderTop} />}
    </div>
  )
}

/* ============================================================================
   HLS MASTER CHOICE. An HLS address is read as a playlist as soon as it is
   typed (the playlist only, not the stream, so it is quick). For a MASTER with
   several variants the field lists them and asks which one this source takes:
   picking one makes its own address the source, and "Back to the master"
   undoes that. "Keep the master" is a choice too: the encoder then picks a
   variant itself, which can change if the provider reorders the list.

   A redirect is always shown, because it can lead somewhere else entirely:
   ABC Jazz's old master address now redirects to NewsRadio's.

   A variant whose audio lives in a separate playlist is listed but cannot be
   picked: its own address carries no sound.

   SAVING: forms call hlsChoicePending() before saving. A NEW master address
   with more than one usable variant and no decision stops the save once, and
   the field below it lights up asking for the choice.
   ========================================================================== */
export const looksLikeHls = (url: string, protocol?: string) =>
  /^https?:\/\//i.test(url.trim()) && ((protocol ?? '').toLowerCase() === 'hls' || /\.m3u8?(\?|#|$)/i.test(url.trim()))

const hlsCache = new Map<string, { at: number; res: Promise<HlsInspection> }>()
function inspect(url: string): Promise<HlsInspection> {
  const hit = hlsCache.get(url)
  if (hit && Date.now() - hit.at < 60_000) return hit.res
  const res = api.inspectHls(url).catch((e: any) => ({ ok: false, error: e?.message ?? String(e) } as HlsInspection))
  hlsCache.set(url, { at: Date.now(), res })
  return res
}
/** Masters somebody chose to keep as they are, and the master each picked variant came from. */
const keptMasters = new Set<string>()
const pickedFrom = new Map<string, string>()
const usable = (r: HlsInspection | null | undefined) => (r?.kind === 'master' ? (r.variants ?? []).filter(v => !v.externalAudio) : [])

/**
 * Before saving: is any NEW HLS master address (one that differs from what was
 * loaded) still waiting for a variant to be chosen? Returns the message to show,
 * or null to go ahead.
 */
export async function hlsChoicePending(sources: { url?: string | null; protocol?: string | null; original?: string | null }[]): Promise<string | null> {
  for (const s of sources) {
    const url = (s.url ?? '').trim()
    if (!url || url === (s.original ?? '').trim() || !looksLikeHls(url, s.protocol ?? undefined) || keptMasters.has(url)) continue
    const r = await inspect(url)
    if (usable(r).length > 1) {
      window.dispatchEvent(new CustomEvent('volt:hls-choose', { detail: url }))
      return `The source is an HLS master playlist with ${usable(r).length} variants. Choose the one to use under the source (or keep the master), then save again.`
    }
  }
  return null
}

const kb = (n: number | null) => n == null ? null : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} Mbps` : `${Math.round(n / 1000)} kbps`
export function variantLabel(v: HlsVariant): string {
  return [v.codecNames.filter(c => c !== 'subtitles').join(' + ') || 'unknown codec', v.resolution?.replace('x', '×'), v.frameRate ? `${v.frameRate} fps` : null,
    kb(v.bandwidth) ? `${kb(v.bandwidth)}${v.averageBandwidth && v.averageBandwidth !== v.bandwidth ? ` (avg ${kb(v.averageBandwidth)})` : ''}` : null,
    v.audioOnly ? 'audio only' : null].filter(Boolean).join(' · ')
}
const tail = (u: string) => { try { const x = new URL(u); return `${x.host}…${x.pathname.split('/').slice(-2).join('/')}` } catch { return u } }

export function HlsChoice({ protocol, url, onPick }: { protocol: string; url: string; onPick: (url: string) => void }) {
  const u = url.trim()
  const on = looksLikeHls(u, protocol)
  const [res, setRes] = useState<{ for: string; r: HlsInspection } | null>(null)
  const [busy, setBusy] = useState(false)
  const [, bump] = useState(0)
  const [ask, setAsk] = useState(false)
  useEffect(() => {
    setAsk(false)
    if (!on) return
    let live = true
    const t = setTimeout(() => { setBusy(true); inspect(u).then(r => { if (live) setRes({ for: u, r }) }).finally(() => live && setBusy(false)) }, 700)
    return () => { live = false; clearTimeout(t) }
  }, [u, on])
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent).detail === u) setAsk(true) }
    window.addEventListener('volt:hls-choose', h)
    return () => window.removeEventListener('volt:hls-choose', h)
  }, [u])
  if (!on) return null
  const r = res?.for === u ? res.r : null
  const master = pickedFrom.get(u)
  if (!r) return busy ? <div className="hintxt">Reading the HLS playlist…</div> : null
  if (!r.ok) return <div className="hintxt" style={{ color: 'var(--warn)' }}>HLS playlist: {r.error}{r.redirectedTo ? ` (after a redirect to ${r.redirectedTo})` : ''}</div>
  const variants = r.variants ?? []
  const audioR = (r.renditions ?? []).filter(x => x.type === 'AUDIO')
  const kept = keptMasters.has(u)
  return (
    <div className={`hls-choice${ask && !kept ? ' ask' : ''}`} role="group" aria-label="HLS playlist">
      {r.redirectedTo && (
        <div className="hls-redirect">
          This address redirects to <span className="mono">{r.redirectedTo}</span>. Check it is the stream you expect: an old address can now point somewhere else.
          <button type="button" className="lineup-suggest" onClick={() => onPick(r.redirectedTo!)}>Use the final address</button>
        </div>
      )}
      {r.kind === 'media' && (
        <div className="hintxt" style={{ marginTop: 0 }}>
          HLS media playlist ({r.live ? 'live' : 'on demand'}{r.targetDuration ? `, ${r.targetDuration} s segments` : ''}): a single variant.
          {master && <> Chosen from <span className="mono">{tail(master)}</span>. <button type="button" className="lineup-suggest" style={{ display: 'inline-block' }} onClick={() => onPick(master)}>Back to the master</button></>}
        </div>
      )}
      {r.kind === 'master' && (
        <>
          <div className="hls-head">
            HLS master playlist: {variants.length} variant{variants.length === 1 ? '' : 's'}
            {audioR.length > 0 && `, ${audioR.length} audio rendition${audioR.length === 1 ? '' : 's'}`}
            {usable(r).length > 1 && <span className="hintxt" style={{ marginTop: 0 }}> Choose the one this source uses.</span>}
          </div>
          {ask && !kept && <div className="hintxt" style={{ color: 'var(--warn)', marginTop: 2 }}>Choose a variant, or keep the master, before saving.</div>}
          <div className="hls-options">
            <label className={`hls-opt${kept ? ' sel' : ''}`}>
              <input type="radio" name={`hls-${u}`} checked={kept} onChange={() => { keptMasters.add(u); setAsk(false); bump(n => n + 1) }} />
              <span><strong>Keep the master</strong><span className="hintxt" style={{ display: 'block', marginTop: 0 }}>The encoder picks a variant itself; which one can change if the provider reorders the list.</span></span>
            </label>
            {variants.map((v, i) => (
              <label key={v.uri + i} className={`hls-opt${v.externalAudio ? ' off' : ''}`} title={v.uri}>
                <input type="radio" name={`hls-${u}`} disabled={v.externalAudio} checked={false}
                  onChange={() => { pickedFrom.set(v.uri, u); keptMasters.delete(u); onPick(v.uri) }} />
                <span>
                  <strong>{variantLabel(v)}</strong>
                  <span className="hintxt mono" style={{ display: 'block', marginTop: 0 }}>{tail(v.uri)}</span>
                  {v.externalAudio && <span className="hintxt" style={{ display: 'block', marginTop: 0, color: 'var(--warn)' }}>Its audio is in a separate playlist ({v.audioGroup}), so this address alone has no sound: keep the master to use it.</span>}
                </span>
              </label>
            ))}
          </div>
          {audioR.length > 0 && (
            <div className="hintxt">Audio renditions: {audioR.map(a => `${a.name}${a.language ? ` (${a.language})` : ''}${a.default ? ', default' : ''}`).join(' · ')}</div>
          )}
        </>
      )}
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
              {shown.hls?.kind === 'master' && (shown.hls.variants?.length ?? 0) > 1 && (
                <div className="hintxt">This is an HLS master, so the tracks above are its {shown.hls.variants!.length} variants together. The source takes one of them: see the choice above.</div>
              )}
              {upscale && <div className="hintxt" style={{ color: 'var(--warn)' }}>The output ladder's top rung is {upscale}p but the source is {v!.height}p, so that rung would be upscaled. Lower it to {v!.height}p or below.</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
