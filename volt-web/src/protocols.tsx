// Protocol-aware source input. The registry is fetched once from the API
// (GET /api/ingest-protocols — the single source of truth) and cached; the source
// form's label / placeholder / example / stream-key field then change to suit the
// selected protocol. A tiny built-in fallback keeps the form usable if the fetch
// is momentarily unavailable. See docs/DESIGN_forms_and_fields.md.
import { useEffect, useState } from 'react'
import { api, type IngestProtocol, type SourceProbe, type HlsInspection, type HlsVariant } from './api'
import { FieldError } from './notices'

// A copy of the server registry (services/ingestProtocols.ts) for the moment
// before it arrives: the same protocols, scopes and required settings.
const FALLBACK: IngestProtocol[] = [
  { id: 'hls', label: 'HLS', ingest: 'pull', urlLabel: 'HLS playlist URL', urlPlaceholder: 'https://…/master.m3u8', urlExample: 'https://cdn.example.com/live/master.m3u8', urlPattern: '^https?://.+\\.m3u8', streamKey: { show: false }, hint: 'We pull this playlist.', scopes: ['video', 'radio'], packageFriendly: true, packaging: 'remux', checkable: true },
  { id: 'dash', label: 'DASH', ingest: 'pull', urlLabel: 'DASH manifest URL', urlPlaceholder: 'https://…/manifest.mpd', urlExample: 'https://cdn.example.com/live/manifest.mpd', urlPattern: '^https?://.+\\.mpd', streamKey: { show: false }, hint: 'We pull this MPD.', scopes: ['video', 'radio'], packageFriendly: true, packaging: 'remux', checkable: true },
  { id: 'srt', label: 'SRT', ingest: 'push', urlLabel: 'SRT address', urlPlaceholder: 'srt://host:9000', urlExample: 'srt://contribution.example.com:9000', urlPattern: '^srt://[^\\s/:]+:\\d{2,5}', streamKey: { show: false }, hint: 'Secure Reliable Transport.', scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true,
    fields: [{ key: 'mode', label: 'Connection', type: 'select', default: 'caller', options: [{ value: 'caller', label: 'Caller (we connect)' }, { value: 'listener', label: 'Listener (it connects)' }] },
      { key: 'latency', label: 'Latency (ms)', type: 'number', default: 200, min: 20, max: 8000 }, { key: 'passphrase', label: 'Passphrase', type: 'password' }] },
  { id: 'rtmp', label: 'RTMP', ingest: 'push', urlLabel: 'RTMP server URL', urlPlaceholder: 'rtmp://host/app', urlExample: 'rtmp://ingest.volt.example/live', urlPattern: '^rtmp://[^\\s/]+/', streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123', required: true }, hint: 'Server URL + stream key.', scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true },
  { id: 'rtmps', label: 'RTMPS', ingest: 'push', urlLabel: 'RTMPS server URL', urlPlaceholder: 'rtmps://host:443/app', urlExample: 'rtmps://ingest.volt.example:443/live', urlPattern: '^rtmps://[^\\s/]+/', streamKey: { show: true, label: 'Stream key', placeholder: 'stream-key-abc123', required: true }, hint: 'RTMP over TLS.', scopes: ['video'], packageFriendly: true, packaging: 'remux', checkable: true },
  { id: 'ndi', label: 'NDI', ingest: 'pull', urlLabel: 'NDI source name', urlPlaceholder: 'STUDIO-PC (Camera 1)', urlExample: 'STUDIO-PC (Camera 1)', urlPattern: '^.+ \\(.+\\)$', streamKey: { show: false }, hint: 'Needs an NDI-enabled ingest node.', scopes: ['video'], packageFriendly: true, packaging: 'encode', checkable: false },
  { id: 'st2110', label: 'ST 2110', ingest: 'pull', urlLabel: 'Video flow (multicast:port)', urlPlaceholder: '239.10.10.1:5000', urlExample: '239.10.10.1:5000', urlPattern: '^\\d{1,3}(\\.\\d{1,3}){3}:\\d{2,5}$', streamKey: { show: false }, hint: 'Needs a 2110 ingest node.', scopes: ['video'], packageFriendly: true, packaging: 'encode', checkable: false,
    fields: [{ key: 'sdp', label: 'SDP', type: 'text', required: true }] },
  { id: 'icecast', label: 'Icecast / HTTP audio', ingest: 'pull', urlLabel: 'Stream URL (mount)', urlPlaceholder: 'https://ice.example.com/station-128-mp3', urlExample: 'https://ice.example.com/station-128-mp3', urlPattern: '^https?://', streamKey: { show: false }, hint: 'Icecast / SHOUTcast mount.', scopes: ['radio'], packageFriendly: true, packaging: 'remux', checkable: true },
]

let cache: IngestProtocol[] | null = null
let inflight: Promise<IngestProtocol[]> | null = null

/**
 * The source types this form may offer. `video` (channels and events): HLS,
 * DASH, SRT, RTMP, RTMPS, NDI, ST 2110, never Icecast. `radio`: the station
 * protocols. No scope: everything (the radio pages, which filter themselves).
 */
export function useProtocols(scope?: 'video' | 'radio'): IngestProtocol[] {
  const pick = (all: IngestProtocol[]) => scope ? all.filter(p => (p.scopes ?? ['video', 'radio']).includes(scope) && (scope !== 'video' || p.id !== 'icecast')) : all
  const [protocols, setProtocols] = useState<IngestProtocol[]>(pick(cache ?? FALLBACK))
  useEffect(() => {
    if (cache) { setProtocols(pick(cache)); return }
    inflight = inflight ?? api.ingestProtocols().then(r => (cache = r.protocols?.length ? r.protocols : FALLBACK))
    inflight.then(all => setProtocols(pick(all))).catch(() => setProtocols(pick(FALLBACK)))
  }, [scope])
  return protocols
}

export function protoOf(protocols: IngestProtocol[], id: string): IngestProtocol {
  return protocols.find(p => p.id === id) ?? protocols[0] ?? FALLBACK[0]
}

export type SourceParams = Record<string, string | number>
export interface SourceValue { protocol: string; url: string; streamKey?: string; params?: SourceParams }

/** A stored input row back into the form's value. */
export function sourceFromRow(r: { protocol?: string | null; ingest_url?: string | null; stream_key?: string | null; params?: SourceParams | null } | undefined, fallbackProtocol = 'srt'): SourceValue {
  return { protocol: (r?.protocol || fallbackProtocol).toLowerCase(), url: r?.ingest_url || '', streamKey: r?.stream_key || undefined, params: { ...(r?.params ?? {}) } }
}

/** The form's value as the API's source (only settings the protocol defines). */
export function sourceToApi(v: SourceValue, protocols: IngestProtocol[]): { protocol: string; ingestUrl: string; streamKey?: string; params?: SourceParams } {
  const d = protoOf(protocols, v.protocol)
  const params: SourceParams = {}
  for (const f of d.fields ?? []) {
    const x = v.params?.[f.key]
    if (x != null && String(x).trim() !== '') params[f.key] = f.type === 'number' ? Number(x) : String(x).trim()
  }
  return { protocol: v.protocol, ingestUrl: v.url.trim(), streamKey: d.streamKey.show ? (v.streamKey?.trim() || undefined) : undefined, ...(Object.keys(params).length ? { params } : {}) }
}

const isIp = (v: string) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(v) && v.split('.').every(n => Number(n) <= 255)

/**
 * What is missing or wrong for this protocol, in words, or null. The same
 * rules the server applies (validateSource), so the form says it first.
 */
export function sourceProblem(protocols: IngestProtocol[], v: SourceValue): string | null {
  const d = protoOf(protocols, v.protocol)
  const url = v.url.trim()
  if (!url) return `${d.urlLabel} is required`
  if (d.urlPattern) { try { if (!new RegExp(d.urlPattern, 'i').test(url)) return `${d.urlLabel} should look like ${d.urlExample}` } catch { /* */ } }
  if (d.streamKey.required && !v.streamKey?.trim() && url.replace(/^rtmps?:\/\/[^/]+/i, '').split('/').filter(Boolean).length < 2) return `${d.label} needs the stream key`
  for (const f of d.fields ?? []) {
    const x = String(v.params?.[f.key] ?? '').trim()
    if (f.required && !x) return `${f.label} is required for ${d.label}`
    if (x && f.type === 'number' && (!Number.isFinite(Number(x)) || (f.min != null && Number(x) < f.min) || (f.max != null && Number(x) > f.max))) return `${f.label} must be from ${f.min} to ${f.max}`
  }
  const p = (k: string) => String(v.params?.[k] ?? '').trim()
  if (d.id === 'srt' && p('passphrase') && (p('passphrase').length < 10 || p('passphrase').length > 79)) return 'The SRT passphrase must be 10 to 79 characters'
  if (d.id === 'st2110') {
    const first = Number(url.split('.')[0])
    if (!(first >= 224 && first <= 239)) return 'The video flow is a multicast address (224.x to 239.x) with a port'
    if (p('sdp') && !/^https?:\/\//i.test(p('sdp')) && !/^v=0/m.test(p('sdp'))) return 'The SDP is a URL or the SDP text itself (starting v=0)'
    if (p('interfaceIp') && !isIp(p('interfaceIp'))) return 'The receive interface must be an IPv4 address'
  }
  return null
}

/** The address Check source should open: SRT carries its settings in the URL. */
export function probeUrlFor(v: SourceValue): string {
  if (v.protocol !== 'srt' || !v.url.trim()) return v.url
  try {
    const u = new URL(v.url.trim().replace(/^srt:/i, 'http:'))
    const q = u.searchParams
    const p = v.params ?? {}
    if (!q.has('mode')) q.set('mode', String(p.mode || 'caller'))
    if (p.latency && !q.has('latency')) q.set('latency', String(Number(p.latency) * 1000))
    if (p.passphrase && !q.has('passphrase')) q.set('passphrase', String(p.passphrase))
    if (p.pbkeylen && p.passphrase && !q.has('pbkeylen')) q.set('pbkeylen', String(p.pbkeylen))
    if (p.streamid && !q.has('streamid')) q.set('streamid', String(p.streamid))
    return u.toString().replace(/^http:/, 'srt:')
  } catch { return v.url }
}

/**
 * THE PROTOCOL'S OWN SETTINGS: SRT caller/listener, latency, passphrase,
 * stream id; NDI discovery server and groups; ST 2110 SDP and receive
 * interface. The common ones are shown, the rest under "More settings".
 */
export function ProtocolSettings({ protocol, params, onChange, compact }: {
  protocol: IngestProtocol; params: SourceParams | undefined; onChange: (p: SourceParams) => void; compact?: boolean
}) {
  const [more, setMore] = useState(false)
  const fields = protocol.fields ?? []
  if (!fields.length) return null
  const val = (k: string) => params?.[k] ?? fields.find(f => f.key === k)?.default ?? ''
  const visible = fields.filter(f => !f.when || (f.when.in.includes('*') ? String(val(f.when.key)).trim() !== '' : f.when.in.includes(String(val(f.when.key)))))
  const shown = visible.filter(f => !f.advanced || more)
  const hasMore = visible.some(f => f.advanced)
  const set = (k: string, v: string) => onChange({ ...(params ?? {}), [k]: v })
  return (
    <div className={`proto-settings${compact ? ' compact' : ''}`}>
      <div className="proto-grid">
        {shown.map(f => (
          <div key={f.key} className={`proto-f${f.type === 'text' ? ' wide' : ''}`}>
            <label>{f.label}{f.required && <span className="req"> *</span>}</label>
            {f.type === 'select' ? (
              <select className="inp" value={String(val(f.key))} onChange={e => set(f.key, e.target.value)}>
                {(f.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'text' ? (
              <textarea className="inp" rows={3} value={String(params?.[f.key] ?? '')} placeholder={f.placeholder} onChange={e => set(f.key, e.target.value)} style={{ fontFamily: 'ui-monospace,monospace', fontSize: 'var(--fs-sm)' }} />
            ) : (
              <input className="inp" type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete="off"
                min={f.min} max={f.max} value={String(params?.[f.key] ?? '')} placeholder={f.placeholder ?? (f.default != null ? String(f.default) : '')}
                onChange={e => set(f.key, e.target.value)} />
            )}
            {f.hint && !compact && <div className="hintxt">{f.hint}</div>}
          </div>
        ))}
      </div>
      {hasMore && <button type="button" className="link-btn" onClick={() => setMore(m => !m)}>{more ? 'Fewer settings' : 'More settings'}</button>}
    </div>
  )
}

/** Full protocol-aware source: type, address, stream key, the protocol's own
 *  settings, what is missing, and Check source. */
export function SourceInput({ protocols, value, onChange, label, packageOnly, validate = true, ladderTop }: {
  protocols: IngestProtocol[]
  value: SourceValue
  onChange: (v: SourceValue) => void
  label?: string
  packageOnly?: boolean   // restrict to protocols usable as packaging renditions
  /** Show the Check source control (off where the page has its own probe, e.g. radio). */
  validate?: boolean
  /** Height of the output ladder's top rung, to warn when it would upscale the source. */
  ladderTop?: number
}) {
  const list = packageOnly ? protocols.filter(p => p.packageFriendly) : protocols
  const d = protoOf(protocols, value.protocol)
  const [touched, setTouched] = useState(false)
  const problem = touched && value.url.trim() ? sourceProblem(protocols, value) : null
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <div style={{ display: 'flex', gap: 8 }}>
        <select className="inp" style={{ width: 120 }} value={value.protocol} aria-label="Source type"
          onChange={e => {
            // A different kind of source: its settings start fresh, and an address that
            // cannot be this kind's (srt:// in an ST 2110 field) is cleared.
            const next = protoOf(protocols, e.target.value)
            let keep = true
            try { keep = !next.urlPattern || !value.url.trim() || new RegExp(next.urlPattern, 'i').test(value.url.trim()) } catch { /* */ }
            onChange({ ...value, protocol: e.target.value, params: {}, url: keep ? value.url : '' })
          }}>
          {(list.length ? list : protocols).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input className="inp" value={value.url} aria-label={d.urlLabel} onBlur={() => setTouched(true)}
          onChange={e => onChange({ ...value, url: e.target.value })} placeholder={d.urlPlaceholder} />
      </div>
      {d.streamKey.show && (
        <input className="inp" style={{ marginTop: 8 }} value={value.streamKey ?? ''} aria-label={d.streamKey.label ?? 'Stream key'} autoComplete="off"
          onChange={e => onChange({ ...value, streamKey: e.target.value })} placeholder={`${d.streamKey.label ?? 'Stream key'}${d.streamKey.required ? ' (required)' : ''}: ${d.streamKey.placeholder ?? ''}`} />
      )}
      <div className="hintxt">{d.hint} e.g. <span style={{ fontFamily: 'ui-monospace,monospace', color: 'var(--muted)' }}>{d.urlExample}</span></div>
      <ProtocolSettings protocol={d} params={value.params} onChange={params => onChange({ ...value, params })} />
      {problem && <FieldError>{problem}</FieldError>}
      <HlsChoice protocol={value.protocol} url={value.url} onPick={(url) => onChange({ ...value, url })} />
      {validate && <SourceCheck protocol={value.protocol} url={probeUrlFor(value)} ladderTop={ladderTop} />}
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
/** The master a variant address was picked from, and what the master declares for it. */
export async function declaredForVariant(url: string): Promise<{ master: string; v: HlsVariant } | null> {
  const master = pickedFrom.get(url.trim())
  if (!master) return null
  const r = await inspect(master)
  const v = (r.variants ?? []).find(x => x.uri === url.trim())
  return v ? { master, v } : null
}
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

export function HlsChoice({ protocol, url, onPick, onUseAll, useAllLabel }: {
  protocol: string; url: string
  /** A variant (or the final address of a redirect) was chosen: its address, and the variant. */
  onPick: (url: string, v?: HlsVariant) => void
  /** Packaging: take every usable variant of the master as its own rendition. */
  onUseAll?: (variants: HlsVariant[], master: string) => void
  useAllLabel?: string
}) {
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
          {onUseAll && usable(r).length > 1 && (
            <button type="button" className="btn ghost hls-useall" onClick={() => { const vs = usable(r); for (const v of vs) pickedFrom.set(v.uri, u); onUseAll(vs, u) }}>
              {useAllLabel ?? `Use all ${usable(r).length} variants as renditions`}
            </button>
          )}
          <div className="hls-options">
            <label className={`hls-opt${kept ? ' sel' : ''}`}>
              <input type="radio" name={`hls-${u}`} checked={kept} onChange={() => { keptMasters.add(u); setAsk(false); bump(n => n + 1) }} />
              <span><strong>Keep the master</strong><span className="hintxt" style={{ display: 'block', marginTop: 0 }}>The encoder picks a variant itself; which one can change if the provider reorders the list.</span></span>
            </label>
            {variants.map((v, i) => (
              <label key={v.uri + i} className={`hls-opt${v.externalAudio ? ' off' : ''}`} title={v.uri}>
                <input type="radio" name={`hls-${u}`} disabled={v.externalAudio} checked={false}
                  onChange={() => { pickedFrom.set(v.uri, u); keptMasters.delete(u); onPick(v.uri, v) }} />
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

export function SourceCheck({ protocol, url, ladderTop, expectHeight, expectKbps, compact }: {
  protocol: string; url: string; ladderTop?: number
  /** Packaging: the rendition's label says this height (1080p); warn when the stream is not it. */
  expectHeight?: number
  /** Packaging: the bitrate the rendition row says; warn when the source is far from it. */
  expectKbps?: number
  /** A smaller button label, for rows with two checks (primary and backup). */
  compact?: string
}) {
  const [res, setRes] = useState<{ for: string; probe: SourceProbe; declared?: HlsVariant | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const key = `${protocol}|${url.trim()}`
  const shown = res && res.for === key ? res.probe : null
  useEffect(() => { setErr('') }, [key])

  async function run() {
    setErr(''); setBusy(true)
    try {
      const [probe, picked] = await Promise.all([api.probeSource(url.trim(), protocol), declaredForVariant(url).catch(() => null)])
      setRes({ for: key, probe, declared: picked?.v ?? null })
    }
    catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  const v = shown?.video
  const upscale = v?.height && ladderTop && ladderTop > v.height ? ladderTop : null
  const mislabel = shown?.hls?.kind !== 'master' && v?.height && expectHeight && expectHeight !== v.height ? expectHeight : null
  const br = shown?.bitrate
  const declared = res && res.for === key ? res.declared : null
  const declaredKbps = declared ? Math.round((declared.averageBandwidth ?? declared.bandwidth ?? 0) / 1000) || null : null
  // the number that best says what this source sends: measured, else what the stream reports, else declared
  const sourceKbps = br && br.how !== 'declared' && br.kbps ? br.kbps : declaredKbps
  const offRate = expectKbps && sourceKbps && Math.abs(sourceKbps - expectKbps) / expectKbps > 0.3 ? sourceKbps : null
  const variants = shown?.hls?.kind === 'master' ? (shown.hls.variants ?? []) : []
  return (
    <div className="src-check">
      <button type="button" className="btn ghost" disabled={!url.trim() || busy} onClick={run}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
        {busy ? 'Checking…' : (compact ?? 'Check source')}
      </button>
      <FieldError>{err}</FieldError>
      {shown && (
        <div className="src-check-out" role="status">
          {shown.error && <div className="err" style={{ marginTop: 0 }}>{shown.error}</div>}
          {shown.note && <div className="hintxt" style={{ marginTop: 0 }}>{shown.note}</div>}
          {shown.reachable && (
            <>
              <div className="src-check-head">
                <span className="src-dot ok" aria-hidden="true" /> Receiving
                {shown.container?.format && <span className="src-muted"> · {shown.container.format.split(',')[0]}</span>}
                {sourceKbps ? <span className="src-muted"> · {kbpsText(sourceKbps)}</span> : null}
              </div>
              <div className="kv"><span className="k">Bitrate</span><span className="v">
                {br?.how === 'declared'
                  ? `${kbpsText(br.kbps)}${br.maxKbps && br.maxKbps !== br.kbps ? ` to ${kbpsText(br.maxKbps)}` : ''}, declared by the master (${br.note})`
                  : [br?.kbps ? `${kbpsText(br.kbps)} ${br.how === 'measured' ? 'measured' : 'reported by the stream'}${br.note ? ` (${br.note})` : ''}` : null,
                     declaredKbps ? `${kbpsText(declaredKbps)} declared in the master` : null].filter(Boolean).join(' · ') || (br?.note ?? 'not reported')}
              </span></div>
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
              {variants.length > 0 && (
                <div className="kv"><span className="k">Variants</span><span className="v src-variants">
                  {variants.map((x, i) => <span key={i}>{[x.resolution?.replace('x', '×') ?? (x.audioOnly ? 'audio' : null), kbpsText(Math.round((x.averageBandwidth ?? x.bandwidth ?? 0) / 1000) || null)].filter(Boolean).join(' · ')}</span>)}
                </span></div>
              )}
              {shown.hls?.kind === 'master' && (shown.hls.variants?.length ?? 0) > 1 && (
                <div className="hintxt">This is an HLS master, so the tracks above are its {shown.hls.variants!.length} variants together. The source takes one of them: see the choice above.</div>
              )}
              {offRate && <div className="hintxt" style={{ color: 'var(--warn)' }}>This rendition is set to {kbpsText(expectKbps!)} but the source is about {kbpsText(offRate)}. Set the bitrate to match what is sent.</div>}
              {mislabel && <div className="hintxt" style={{ color: 'var(--warn)' }}>This rendition is labelled {mislabel}p but the stream is {v!.height}p. Correct the label, or check the URL points at the right rendition.</div>}
              {upscale && <div className="hintxt" style={{ color: 'var(--warn)' }}>The output ladder's top rung is {upscale}p but the source is {v!.height}p, so that rung would be upscaled. Lower it to {v!.height}p or below.</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
