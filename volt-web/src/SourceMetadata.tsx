import { useEffect, useRef, useState } from 'react'
import { api, type IcyProbe, type SourceValidation } from './api'
import { pressable } from './a11y'
import { Notice } from './notices'

/* ============================================================================
   SOURCE METADATA — what the stream says about itself, before you save it.

   An Icecast mount announces its own identity: the station name, genre,
   homepage, bitrate, codec, whether it is public, what is playing right now,
   and often a logo URL. All of that is already on the wire the moment the
   operator pastes a URL, and retyping it by hand is both work and a chance to
   get it wrong.

   So: read it, show it, and let each value be ADOPTED with one click. Every row
   that can fill a field on the form carries its own Use button. Nothing is
   applied automatically — the station's own name is often a marketing sentence
   ("Secret Agent: The soundtrack for your stylish, mysterious, dangerous life…")
   which is exactly right as metadata and wrong as a station name in a channel
   list. The operator decides.

   VALIDATE SOURCE (24 Oct 2026). The button is now "Validate source" and it
   answers the question first: does this address work, as it is? For Icecast,
   HLS and DASH the server checks it from the protocol itself, with no ffprobe
   (POST /api/sources/validate, services/sourceValidate.ts): connect, playlist
   or manifest, a segment or a few KB of audio recognised as real media. The
   panel shows each check, what the source is, a sample to listen to (or
   watch) where the browser can play it, and for Icecast the station's own
   metadata with its Use buttons, as before.
   ========================================================================== */

export interface MetadataTargets {
  /** Adopt as the station's name. */
  onName?: (v: string) => void
  /** Adopt the remote image URL as the station's artwork. */
  onArtwork?: (v: string) => void
  /** Adopt the source's bitrate as the output bitrate. */
  onBitrate?: (v: number) => void
  /** Replace the entered URL with the resolved one (playlist -> real mount). */
  onUrl?: (v: string) => void
}

const IMG = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i

/** Protocols the server can validate without a probe. */
const VALIDATABLE = ['icecast', 'hls', 'dash', '']

export function SourceValidateButton({ url, protocol = '', targets }: { url: string; protocol?: string; targets: MetadataTargets }) {
  const [open, setOpen] = useState(false)
  const proto = protocol.toLowerCase()
  const supported = VALIDATABLE.includes(proto)
  const ready = supported && /^https?:\/\/.+/i.test(url.trim())
  return (
    <>
      <button className="btn ghost" type="button" disabled={!ready} onClick={() => setOpen(true)}
        title={!supported ? `${proto.toUpperCase()} is checked when a feed arrives` : ready ? 'Check this source works as it is, see what it is, and listen to a sample' : 'Enter a source URL first'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" />
        </svg>
        Validate source
      </button>
      {open && <SourceMetadataPanel url={url.trim()} protocol={proto} targets={targets} onClose={() => setOpen(false)} />}
    </>
  )
}
/** Kept for older imports: the same control. */
export const SourceMetadataButton = SourceValidateButton

const STATE_ICON: Record<string, { c: string; d: string }> = {
  pass: { c: '#4ade80', d: 'M5 12l4 4 10-10' },
  warn: { c: '#fbbf24', d: 'M12 8v5M12 17h.01' },
  fail: { c: '#f87171', d: 'M6 6l12 12M18 6L6 18' },
  skip: { c: 'var(--faint)', d: 'M6 12h12' },
}

function SourceMetadataPanel({ url, protocol, targets, onClose }: {
  url: string; protocol: string; targets: MetadataTargets; onClose: () => void
}) {
  const [res, setRes] = useState<SourceValidation | null>(null)
  const [err, setErr] = useState('')
  const [applied, setApplied] = useState<Record<string, boolean>>({})

  async function run() {
    setRes(null); setErr(''); setApplied({})
    try { setRes(await api.validateSource(url, protocol || undefined)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { run() /* eslint-disable-next-line */ }, [url, protocol])
  const probe: IcyProbe | null = res?.icy ?? null

  const mark = (k: string, fn: () => void) => { fn(); setApplied(a => ({ ...a, [k]: true })) }
  const st = probe?.station ?? {}
  // Artwork can arrive as StreamUrl even when it is a link rather than an image;
  // only offer it as artwork when it actually points at one.
  const art = probe?.artworkUrl ?? (probe?.streamUrl && IMG.test(probe.streamUrl) ? probe.streamUrl : null)

  return (
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 70, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(620px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-h1)', letterSpacing: 'var(--ls-title)' }}>Validate source</h2>
          <div className="flex-1" />
          <button className="btn ghost" onClick={run}>Re-read</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4, wordBreak: 'break-all', fontSize: 'var(--fs-sm)' }}>{url}</p>

        {err && <Notice kind="error" variant="compact" message={err} />}
        {!res && !err && <div className="loading">Checking the source…</div>}

        {res && (
          <>
            <div style={{ padding: '12px 14px', borderRadius: 10, marginTop: 12,
              background: res.ok ? 'rgba(74,222,128,.08)' : 'rgba(248,113,113,.10)',
              border: `1px solid ${res.ok ? 'rgba(74,222,128,.35)' : 'rgba(248,113,113,.4)'}` }}>
              <div style={{ fontWeight: 700, color: res.ok ? '#86efac' : '#fca5a5' }}>{res.verdict}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)', marginTop: 3 }}>
                {res.kind === 'icecast' ? 'Icecast' : res.kind === 'hls' ? 'HLS' : res.kind === 'dash' ? 'DASH' : res.kind === 'push' ? 'Push source' : 'Source'}
                {' · checked from the server in '}{(res.elapsedMs / 1000).toFixed(1)} s, no probe
                {!res.ok && res.checks.some(c => c.state === 'fail') && ' · you can still save it: the station reports the same error in its event log when started'}
              </div>
            </div>

            <div className="sec-label">Checks</div>
            <div className="grid gap-1.5">
              {res.checks.map(c => {
                const ic = STATE_ICON[c.state]
                return (
                  <div key={c.id} className="flex items-start gap-2" style={{ fontSize: 'var(--fs-body)' }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={ic.c} strokeWidth="2.5" style={{ flex: 'none', marginTop: 3 }}
                      aria-label={c.state}><path d={ic.d} /></svg>
                    <span style={{ width: 116, flex: 'none', color: 'var(--faint)' }}>{c.label}</span>
                    <span className="flex-1 min-w-0" style={{ wordBreak: 'break-word' }}>{c.detail}</span>
                  </div>
                )
              })}
            </div>

            {/* Icecast's name, genre and bitrate are in the station block below, with Use buttons. */}
            {res.facts.filter(f => res.kind !== 'icecast' || !['Station', 'Genre', 'Bitrate'].includes(f.k)).length > 0 && (
              <>
                <div className="sec-label">{res.kind === 'icecast' ? 'Audio, as received' : 'What it is'}</div>
                <div className="grid gap-1.5">
                  {res.facts.filter(f => res.kind !== 'icecast' || !['Station', 'Genre', 'Bitrate'].includes(f.k))
                    .map((f, i) => <Row key={f.k + i} k={f.k} v={f.v} />)}
                </div>
              </>
            )}

            {res.preview && (
              <>
                <div className="sec-label">Sample</div>
                <SamplePlayer preview={res.preview}
                  video={res.kind !== 'icecast' && !(res.hls?.variants?.length && res.hls.variants.every(v => v.audioOnly))
                    && res.facts.some(f => f.k === 'Video' || /\d+x\d+/.test(f.v))} />
              </>
            )}
          </>
        )}

        {probe?.ok && (
          <>
            {probe.resolved && (
              <div className="hintxt" style={{ marginTop: 10 }}>
                That URL is a playlist. The real mount is <b style={{ wordBreak: 'break-all' }}>{probe.url}</b>.
                {targets.onUrl && (
                  <button className="btn ghost" style={{ marginLeft: 8, padding: '2px 9px' }}
                    onClick={() => mark('url', () => targets.onUrl!(probe.url))}>
                    {applied.url ? 'Used' : 'Use the mount'}
                  </button>
                )}
              </div>
            )}

            <div className="sec-label">What the station announces</div>
            <div className="grid gap-1.5">
              <Row k="Station name" v={st.name}
                action={st.name && targets.onName ? { label: applied.name ? 'Used' : 'Use as name', on: () => mark('name', () => targets.onName!(st.name!)) } : undefined} />
              <Row k="Genre" v={st.genre} />
              <Row k="Description" v={st.description} />
              <Row k="Website" v={st.url} />
              <Row k="Bitrate" v={st.bitrateKbps ? `${st.bitrateKbps} kbps` : undefined}
                action={st.bitrateKbps && targets.onBitrate ? { label: applied.bitrate ? 'Used' : 'Match output', on: () => mark('bitrate', () => targets.onBitrate!(st.bitrateKbps!)) } : undefined} />
              <Row k="Codec" v={st.contentType} />
              <Row k="Listing" v={st.public === undefined ? undefined : st.public ? 'Public directory' : 'Not listed'} />
            </div>

            <div className="sec-label">Now playing</div>
            {probe.hasMetadata ? (
              <div className="grid gap-1.5">
                <Row k="Title" v={probe.nowPlaying || '(the station sent an empty title)'} />
                <Row k="Metadata every" v={probe.metaIntervalBytes ? `${probe.metaIntervalBytes.toLocaleString()} bytes` : undefined} />
              </div>
            ) : (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                This mount does not interleave ICY metadata, so there will be no now-playing log and no
                song / ad / content classification. Recording, packaging and QC all still work.
              </div>
            )}

            <div className="sec-label">Artwork</div>
            {art ? (
              <div className="flex items-center gap-3">
                <img src={art} alt="" style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--border)', flex: 'none' }} />
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 'var(--fs-xs)', fontFamily: 'ui-monospace,monospace', color: 'var(--muted)', wordBreak: 'break-all' }}>{art}</div>
                  <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)', marginTop: 3 }}>
                    Published by the station. Saving it keeps the remote URL, so it follows their artwork if they change it.
                  </div>
                </div>
                {targets.onArtwork && (
                  <button className="btn primary" style={{ flex: 'none' }}
                    onClick={() => mark('art', () => targets.onArtwork!(art))}>
                    {applied.art ? 'Saved' : 'Use as artwork'}
                  </button>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>
                {probe.streamUrl
                  ? <>The station sends a link rather than an image: <span style={{ fontFamily: 'ui-monospace,monospace' }}>{probe.streamUrl}</span></>
                  : 'This station does not publish artwork with its metadata.'}
              </div>
            )}

          </>
        )}
        {(res || err) && (
          <div className="flex gap-2 justify-end" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ k, v, action }: { k: string; v?: string | null; action?: { label: string; on: () => void } }) {
  return (
    <div className="flex items-start gap-2" style={{ fontSize: 'var(--fs-body)' }}>
      <span style={{ width: 132, flex: 'none', color: 'var(--faint)' }}>{k}</span>
      <span className="flex-1 min-w-0" style={{ color: v ? undefined : 'var(--faint)', wordBreak: 'break-word' }}>
        {v || 'not sent'}
      </span>
      {action && (
        <button className="btn ghost" style={{ flex: 'none', padding: '2px 9px', fontSize: 'var(--fs-sm)' }} onClick={action.on}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/* A SAMPLE of the source, played in the browser straight from its address.
   Icecast is plain HTTP audio (no CORS needed for an <audio> that is not read
   by script); HLS uses native playback on Safari and hls.js elsewhere; DASH
   uses dash.js. Those two read the playlist with fetch, so they need the
   source to allow cross-origin requests: when it does not, the sample fails
   and says so, which is about the browser, not the source the server checked. */
function SamplePlayer({ preview, video }: { preview: NonNullable<SourceValidation['preview']>; video: boolean }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState('')
  const [secs, setSecs] = useState(0)
  const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && preview.url.startsWith('http:')

  useEffect(() => {
    const a = ref.current
    if (!a) return
    let killed = false; let hls: any = null; let dash: any = null
    setErr('')
    async function attach() {
      if (!a) return
      try {
        if (preview.kind === 'audio' || (preview.kind === 'hls' && a.canPlayType('application/vnd.apple.mpegurl'))) {
          a.src = preview.url; await a.play(); return
        }
        if (preview.kind === 'hls') {
          const Hls = (await import('hls.js')).default
          if (killed) return
          if (!Hls.isSupported()) { setErr('HLS is not supported in this browser'); return }
          hls = new Hls({ liveDurationInfinity: true })
          hls.loadSource(preview.url); hls.attachMedia(a)
          hls.on(Hls.Events.MANIFEST_PARSED, () => a.play().catch(() => {}))
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
            if (!d?.fatal) return
            setErr(/manifestLoadError|NetworkError|manifestLoad/i.test(String(d.details)) && d.response?.code === 0
              ? 'the browser was not allowed to read the playlist (the source sends no CORS header). The server check above is what counts.'
              : (d.details || 'playback failed'))
          })
          return
        }
        const dashjs: any = (await import('dashjs')).default
        if (killed) return
        dash = dashjs.MediaPlayer().create()
        dash.initialize(a, preview.url, true)
        try { dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => setErr(e?.error?.message || 'playback failed (the source may not allow cross-origin requests)')) } catch { /* ignore */ }
      } catch (e: any) {
        if (!killed) setErr(e?.name === 'NotAllowedError' ? 'the browser blocked autoplay: press play again' : (e?.message || 'playback failed'))
      }
    }
    if (playing) attach()
    else { a.pause(); a.removeAttribute('src'); a.load(); setSecs(0) }
    return () => {
      killed = true
      if (hls) { try { hls.destroy() } catch { /* ignore */ } }
      if (dash) { try { dash.reset() } catch { /* ignore */ } }
      try { a.pause() } catch { /* ignore */ }
    }
  }, [playing, preview.url, preview.kind])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setSecs(Math.floor(ref.current?.currentTime || 0)), 1000)
    return () => clearInterval(t)
  }, [playing])

  const label = playing ? 'Stop the sample' : 'Play a sample'
  return (
    <div>
      <div className="flex items-center gap-3">
        <button className="icon-btn" type="button" onClick={() => setPlaying(p => !p)} aria-label={label} title={label} disabled={mixed}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            {playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
          </svg>
        </button>
        <div className="flex-1 min-w-0" style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
          {mixed ? 'This console is on https and the source is http: the browser will not play it here. The server check above still applies.'
            : playing ? (err ? <span style={{ color: '#fca5a5' }}>Sample: {err}</span> : `Playing from the source · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`)
            : `Listen${video ? ' and watch' : ''} straight from the source in this browser.`}
        </div>
      </div>
      {video
        ? <video ref={ref} muted={false} playsInline controls={playing} style={{ display: playing ? 'block' : 'none', width: '100%', maxHeight: 240, marginTop: 10, borderRadius: 8, background: '#000' }} />
        : <audio ref={ref} style={{ display: 'none' }} />}
    </div>
  )
}
