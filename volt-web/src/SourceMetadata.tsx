import { useEffect, useState } from 'react'
import { api, type IcyProbe } from './api'
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

export function SourceMetadataButton({ url, targets }: { url: string; targets: MetadataTargets }) {
  const [open, setOpen] = useState(false)
  const ready = /^https?:\/\/.+/i.test(url.trim())
  return (
    <>
      <button className="btn ghost" type="button" disabled={!ready} onClick={() => setOpen(true)}
        title={ready ? 'Read what this stream says about itself' : 'Enter a source URL first'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        View metadata
      </button>
      {open && <SourceMetadataPanel url={url.trim()} targets={targets} onClose={() => setOpen(false)} />}
    </>
  )
}

function SourceMetadataPanel({ url, targets, onClose }: {
  url: string; targets: MetadataTargets; onClose: () => void
}) {
  const [probe, setProbe] = useState<IcyProbe | null>(null)
  const [err, setErr] = useState('')
  const [applied, setApplied] = useState<Record<string, boolean>>({})

  async function run() {
    setProbe(null); setErr(''); setApplied({})
    try { setProbe(await api.probeRadioSource(url)) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { run() /* eslint-disable-next-line */ }, [url])

  const mark = (k: string, fn: () => void) => { fn(); setApplied(a => ({ ...a, [k]: true })) }
  const st = probe?.station ?? {}
  // Artwork can arrive as StreamUrl even when it is a link rather than an image;
  // only offer it as artwork when it actually points at one.
  const art = probe?.artworkUrl ?? (probe?.streamUrl && IMG.test(probe.streamUrl) ? probe.streamUrl : null)

  return (
    <div {...pressable((e: any) => { ((onClose) as any)(e) })} data-a11y-click="" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,14,.6)', zIndex: 70, display: 'grid', placeItems: 'center', padding: 20 }}>
      <div {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="" style={{ width: 'min(620px,96vw)', maxHeight: '92vh', overflow: 'auto', background: 'var(--panel,#0e1420)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--fs-h1)', letterSpacing: 'var(--ls-title)' }}>Source metadata</h2>
          <div className="flex-1" />
          <button className="btn ghost" onClick={run}>Re-read</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--muted)', marginTop: 4, wordBreak: 'break-all', fontSize: 'var(--fs-sm)' }}>{url}</p>

        {err && <Notice kind="error" variant="compact" message={err} />}
        {!probe && !err && <div className="loading">Reading the stream…</div>}

        {probe && !probe.ok && (
          <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.4)', marginTop: 12 }}>
            <div style={{ fontWeight: 700, color: '#fca5a5', marginBottom: 4 }}>Could not read this source</div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
              {probe.error || 'no answer'}. The URL may be wrong, the station may be off air, or it may block this server.
              You can still save it: the station will report the same error in its event log when you start it.
            </div>
          </div>
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

            <div className="flex gap-2 justify-end" style={{ marginTop: 18 }}>
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
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
