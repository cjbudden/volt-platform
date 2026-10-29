// ============================================================================
//  A FAST CHANNEL AS A CHANNEL: its Overview and Settings, beside the Build
//  views in pages/Fast.tsx.
//
//  A FAST channel is a channel (channels.origin = 'playlist'), so it has what
//  any channel has and is saved the same way (PATCH /api/channels/:id): a name,
//  a content type with its metadata (title, description, genre...), a logo and
//  guide icon, a watermark and in-stream graphics.
//
//  THE WATERMARK IS DRAWN BY THE PLAYER. The playout copies packaged segments
//  without re-encoding them (fast_playout.py), so there is no encoder to burn a
//  logo in. The play gate hands the channel's watermark to every Volt player
//  (apps.ts fastBrandMark -> sdk BrandMark) and the console preview draws the
//  same mark here, at the same place and size the settings frame shows.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, thumbUrl, type FillerAsset } from '../api'
import { useNotify, Notice } from '../notices'
import { useAccess } from '../access'
import { navigate } from '../router'
import { TypePicker, MetadataForm } from '../ContentTypeFields'
import { ImageRefField, GuideIconField } from '../ImageRefField'
import { WatermarkFields, wmDefaults, wmPatch, wmProblem, type WmForm } from '../WatermarkFields'
import { GraphicsSettings, type GraphicsValue } from '../GraphicsSettings'
import { gfx, type Assignment } from '../graphics/gfxApi'
import { openLiveControl } from '../graphics/Graphics'
import { fastApi, type FastChannelSettings, type RundownRow, type ChannelAds } from './fastApi'
import { signImage } from '../imageSigning'
import { SourceFacts } from '../pages/vod/SourceFacts'
import type { BrandMark } from '@volt/player'

/** The watermark as the player draws it, or null when it is off. */
export function brandMarkOf(s: FastChannelSettings | null | undefined): BrandMark | null {
  const w = s?.watermark
  if (!w?.enabled || !w.ref) return null
  return { url: thumbUrl(w.ref, 640, 640, 'inside'), position: w.position, offsetX: w.offsetX, offsetY: w.offsetY, opacity: w.opacity, scale: w.scale }
}

/**
 * The same settings from the channel itself (GET /channels/:id), for an API
 * that predates `settings` on the FAST channel response.
 */
export async function settingsFromChannel(id: string): Promise<FastChannelSettings | null> {
  try {
    const d: any = await api.channel(id)
    return { version: d.version ?? null, schemaId: d.schemaId ?? null, metadata: d.metadata ?? {}, brandRef: d.brand_ref ?? null, guideIconRef: d.guide_icon_ref ?? null,
      graphics: d.graphics ?? {}, epgEnabled: d.epgEnabled !== false, watermark: d.watermark ?? { enabled: false, ref: null, position: 'br', offsetX: 24, offsetY: 24, opacity: 100, scale: 12 } }
  } catch { return null }
}

const abs = (u: string) => /^https?:\/\//i.test(u) ? u : `${window.location.origin}${u}`

function CopyRow({ label, sub, url, note }: { label: string; sub?: string; url: string; note?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(abs(url)); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard refused */ } }
  return (
    <div className="ou-row-wrap">
      <div className="ou-row">
        <span className="ou-fmt">{label}{sub && <span className="ou-sub">{sub}</span>}</span>
        <code className="ou-url" title={abs(url)}>{url}</code>
        {note ? <span className="ou-st">{note}</span> : <span />}
        <button type="button" className="btn ghost ou-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}

/** Every address the channel has: viewers', the console's, ad-stitched sessions and the public guide. */
export function FastUrlsCard({ id, onAir, urls, stitched, media }: {
  id: string; onAir: boolean; stitched: boolean; media: 'video' | 'audio'
  urls: { hls: string; dash: string; session: string } | null
}) {
  return (
    <div className="card ou-card">
      <div className="ou-head"><div className="sec-label" style={{ margin: 0 }}>Channel URLs</div></div>
      <div className="ou-group">
        <div className="ou-gh"><b>Public playback</b><span>{onAir
          ? 'What viewers and apps use. Open now, subject to geo and access rules.'
          : 'What viewers and apps will use. These answer "not on air" until the channel goes live.'}</span></div>
        <CopyRow label="HLS" url={`/live/${id}/master.m3u8`} note={onAir ? 'public' : 'private'} />
        {media === 'video' && <CopyRow label="DASH" url={`/live/${id}/manifest.mpd`} note={onAir ? 'public' : 'private'} />}
        {stitched && urls?.session && <CopyRow label="HLS" sub="per viewer, ads stitched" url={urls.session} note="{session} per viewer" />}
      </div>
      {urls && <div className="ou-group">
        <div className="ou-gh"><b>Private monitoring</b><span>The playout's own output, public or not. For checking the channel, not for viewers.</span></div>
        <CopyRow label="HLS" url={urls.hls} />
        {media === 'video' && <CopyRow label="DASH" url={urls.dash} />}
      </div>}
      <div className="ou-group">
        <div className="ou-gh"><b>Guide</b><span>The public EPG API: what is on now, next and later, for apps and partners.</span></div>
        <CopyRow label="Now" sub="now / next / previous" url={`/api/public/epg/channels/${id}/now`} />
        <CopyRow label="Schedule" url={`/api/public/epg/channels/${id}/schedule`} />
      </div>
    </div>
  )
}

/** What the channel says about itself: logo, title, description, content type, watermark. */
export function FastIdentityCard({ name, s, onEdit }: { name: string; s: FastChannelSettings | null; onEdit: () => void }) {
  const logo = s?.guideIconRef || s?.brandRef
  const m = s?.metadata ?? {}
  const desc = m.description ?? m.shortDescription ?? m.longDescription ?? null
  const genre = Array.isArray(m.genre) ? m.genre.join(', ') : m.genre
  return (
    <div className="card">
      <div className="card-h"><h3>Channel</h3><span className="spacer" /><button className="btn ghost sm" onClick={onEdit}>Edit</button></div>
      <div className="card-b fast-id">
        <div className="fast-id-logo">{logo ? <img src={thumbUrl(logo, 240, 240, 'inside')} alt="" /> : <span>{name.slice(0, 2).toUpperCase()}</span>}</div>
        <div style={{ minWidth: 0 }}>
          <div className="fast-id-nm">{m.title || name}</div>
          {desc ? <div className="fast-id-d">{desc}</div> : <div className="fast-id-d faint">No description yet. Add one in Settings: it is what guides and apps show for the channel.</div>}
          <div className="fast-id-tags">
            {genre && <span className="tag type">{genre}</span>}
            <span className={`tag ${s?.watermark.enabled && s.watermark.ref ? 'live' : 'idle'}`}>{s?.watermark.enabled && s.watermark.ref ? 'Watermark on' : 'No watermark'}</span>
            <span className={`tag ${s?.graphics?.upNext?.enabled === false ? 'idle' : 'type'}`}>{s?.graphics?.upNext?.enabled === false ? 'Up next off' : 'Up next on'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The graphics on this channel, with the way to live control and to assign more. */
export function FastGraphicsCard({ channelId }: { channelId: string }) {
  const { can } = useAccess()
  const [items, setItems] = useState<Assignment[] | null>(null)
  useEffect(() => {
    if (!can('graphics', 'view')) { setItems([]); return }
    gfx.assignments({ channel_id: channelId }).then(r => setItems(r.items)).catch(() => setItems([]))
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps
  const inUse = (items ?? []).filter(a => a.enabled)
  return (
    <div className="card">
      <div className="card-h"><h3>Graphics</h3><span className="sub">drawn by the player over the channel</span><span className="spacer" />
        {inUse.length > 0 && <button className="btn ghost sm" onClick={() => openLiveControl({ channelId })}>Live control</button>}
        {can('graphics', 'manage') && <button className="btn ghost sm" onClick={() => navigate('/graphics?tab=assignments')}>Assign</button>}</div>
      {!items ? <div className="card-b loading">Loading…</div>
        : !inUse.length ? <div className="card-b" style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>No graphics on this channel. Assign a setup (a bug, lower third, ticker) under Graphics &gt; Assignments.</div>
        : inUse.map(a => (
          <div key={a.id} className="fast-ready">
            <div style={{ minWidth: 0 }}><div className="nm">{a.setupName}</div><div className="meta">{a.templateName} · {a.describe}</div></div>
            <span className={`tag ${a.onAir ? 'live' : 'idle'}`}>{a.onAir ? 'On air' : 'Ready'}</span>
          </div>
        ))}
    </div>
  )
}

/** The channel's settings, saved through PATCH /api/channels/:id. */
export function FastSettingsView({ id, name: name0, s, hasGuide, onSaved }: {
  id: string; name: string; s: FastChannelSettings; hasGuide: boolean; onSaved: () => void
}) {
  const notify = useNotify()
  const [name, setName] = useState(name0)
  const [typeId, setTypeId] = useState<string | null>(s.schemaId)
  const [meta, setMeta] = useState<Record<string, any>>(s.metadata ?? {})
  const [brandRef, setBrandRef] = useState(s.brandRef ?? '')
  const [guideIcon, setGuideIcon] = useState(s.guideIconRef ?? '')
  const [wm, setWm] = useState<WmForm>(wmDefaults(s.watermark))
  const [gfxV, setGfxV] = useState<GraphicsValue>(s.graphics ?? {})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Unsaved when the form differs from what was loaded (a content type the
  // picker filled in on a channel without one counts: it is not saved yet).
  const snap = (x: unknown[]) => JSON.stringify(x)
  const [initial, setInitial] = useState(() => snap([name0, s.schemaId, s.metadata ?? {}, s.brandRef ?? '', s.guideIconRef ?? '', wmDefaults(s.watermark), s.graphics ?? {}]))
  const current = snap([name, typeId, meta, brandRef, guideIcon, wm, gfxV])
  const dirty = current !== initial
  const setDirty = (d: boolean) => { if (!d) setInitial(current) }

  const save = async () => {
    setErr('')
    if (!name.trim()) { setErr('Give the channel a name'); return }
    const w = wmProblem(wm); if (w) { setErr(w); return }
    setBusy(true)
    try {
      await api.updateChannel(id, {
        ...(s.version != null ? { version: s.version } : {}),
        ...(name.trim() !== name0 ? { name: name.trim() } : {}),
        ...(typeId ? { schemaId: typeId, metadata: meta } : {}),
        brandRef: brandRef.trim() || null, guideIconRef: guideIcon.trim() || null,
        watermark: wmPatch(wm), graphics: gfxV,
      })
      notify({ kind: 'ok', title: 'Channel settings saved.', message: wm.enabled ? 'Players pick up the watermark the next time they load the channel.' : undefined })
      setDirty(false); onSaved()
    } catch (e: any) {
      setErr(/409|version|match/i.test(String(e.message)) ? 'This channel changed since you opened it. Reload the page and try again.' : e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="grid-2 fast-settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card"><div className="card-h"><h3>About the channel</h3><span className="sub">what guides, apps and the player show</span></div>
          <div className="card-b">
            <div className="field"><label>Name</label><input className="inp" value={name} onChange={e => setName(e.target.value)} /></div>
            <TypePicker appliesTo="tv" value={typeId} onChange={(tid) => setTypeId(tid)} hint="Decides the channel's metadata: title, description, genre and the rest guides and apps read." />
            <MetadataForm typeId={typeId} value={meta} onChange={setMeta} entityName={{ value: name, where: 'channel' }} hide={['logo']} imageFolder={`fast/${name0}`} />
          </div>
        </div>
        <div className="card"><div className="card-h"><h3>Logo and artwork</h3></div>
          <div className="card-b">
            <ImageRefField label="Channel logo" hint=": the channel's identity in the console, guides and apps"
              value={brandRef} onChange={setBrandRef} pickerTitle="Choose or upload the channel logo" kinds={['brand', 'poster', 'other']} />
            <GuideIconField value={guideIcon} onChange={setGuideIcon} brandRef={brandRef} />
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="card"><div className="card-h"><h3>Watermark</h3><span className="sub">the channel brand over the picture</span></div>
          <div className="card-b">
            <WatermarkFields value={wm} onChange={(p) => setWm(x => ({ ...x, ...p }))}
              hint="Drawn by the player, not burned in: a FAST channel's programmes are copied to air untouched. Every Volt player, embed and share link shows it; a third-party player given the bare URL does not." />
          </div>
        </div>
        <div className="card"><div className="card-b">
          <GraphicsSettings value={gfxV} onChange={setGfxV} hasGuide={hasGuide} />
        </div></div>
        {err && <Notice kind="error" variant="compact" message={err} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
//  ON AIR NOW: the right-hand half of the Overview's split, beside the output
//  preview, as a live channel shows its source beside its output. What the
//  playout is sending this second (programme, ident, house spot or brand
//  loop, from the same timeline the playout reads: GET /fast/channels/:id/
//  rundown), with the asset's poster, where in it the channel is, its
//  metadata and its encode: resolution, codecs, bitrates, renditions,
//  formats, and the source file in full.
// ============================================================================
const ROW_KIND: Record<string, { label: string; cls: string }> = {
  programme: { label: 'Programme', cls: 'live' }, break: { label: 'Ad break', cls: 'warn' }, ident: { label: 'Ident', cls: 'type' },
  loop: { label: 'Brand loop', cls: 'type' }, house: { label: 'House spot', cls: 'sched' }, slate: { label: 'Slate', cls: 'idle' },
}
const mmss = (sec: number) => { const s = Math.max(0, Math.round(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}` }
const clockOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const kbps = (k?: number | null) => (k ? (k >= 1000 ? `${(k / 1000).toFixed(1)} Mb/s` : `${k} kb/s`) : null)
const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', aac: 'AAC', mp3: 'MP3', opus: 'Opus', ac3: 'AC-3', eac3: 'E-AC-3', prores: 'ProRes' }
const codec = (c?: string | null) => (c ? CODEC[c] ?? c.toUpperCase() : null)

function posterOf(a: any): string | null {
  if (a?.poster_key) { const k = String(a.poster_key).replace(/^\/+/, ''); return signImage('640x360,cover', k) ?? thumbUrl(`/${k}`, 640, 360, 'cover') }
  const img = a?.metadata?.image ?? a?.metadata?.posterUrl
  return typeof img === 'string' ? thumbUrl(img, 640, 360, 'cover') : null
}

export function OnAirNowCard({ channelId, playing, guideNow }: {
  channelId: string; playing: boolean
  /** The guide's programme now (channel detail epg.now), shown while the rundown cannot be read. */
  guideNow?: { name: string; startMs: number; endMs: number } | null
}) {
  const [rows, setRows] = useState<RundownRow[] | null>(null)
  const [err, setErr] = useState('')
  const [now, setNow] = useState(Date.now())
  const [asset, setAsset] = useState<any | null>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    let gone = false
    const load = () => fastApi.rundown(channelId, 2).then(r => { if (!gone) { setRows(r.items); setErr('') } }).catch((e: any) => { if (!gone) setErr(e.message) })
    load(); const t = window.setInterval(load, 20_000)
    return () => { gone = true; window.clearInterval(t) }
  }, [channelId])
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [])
  const list = rows ?? []
  const ci = list.findIndex(r => Date.parse(r.start) <= now && Date.parse(r.end) > now)
  const cur = ci >= 0 ? list[ci] : null
  const next = list.slice(ci + 1).find(r => r.kind === 'programme' && r.part !== 'resumes') ?? null
  // the asset on air; during an ad break, the programme it interrupts
  const assetId = cur?.assetId ?? (cur?.kind === 'break' ? [...list.slice(0, ci)].reverse().find(r => r.kind === 'programme')?.assetId : null) ?? null
  useEffect(() => {
    if (!assetId) { setAsset(null); return }
    let gone = false
    api.vodAsset(assetId).then(a => { if (!gone) setAsset(a) }).catch(() => { if (!gone) setAsset(null) })
    return () => { gone = true }
  }, [assetId])

  if (err && guideNow) return (
    <div className="card fast-now"><div className="card-h"><h3>On air now</h3><span className="tag live">Programme</span></div>
      <div className="card-b">
        <div className="fast-now-t">{guideNow.name}</div>
        <div className="fast-now-sub">{clockOf(new Date(guideNow.startMs).toISOString())} – {clockOf(new Date(guideNow.endMs).toISOString())} · {mmss((guideNow.endMs - now) / 1000)} left</div>
        <div className="fast-now-bar"><i style={{ width: `${Math.min(100, ((now - guideNow.startMs) / Math.max(1, guideNow.endMs - guideNow.startMs)) * 100)}%` }} /></div>
        <div className="hintxt" style={{ marginTop: 12 }}>From the guide. The asset, its encode and metadata show here once the API server is running this version (restart it).</div>
      </div></div>)
  if (err) return <div className="card"><div className="card-h"><h3>On air now</h3></div><div className="card-b"><Notice kind="error" variant="compact" message={err} /></div></div>
  if (!rows) return <div className="card"><div className="card-h"><h3>On air now</h3></div><div className="card-b loading">Loading…</div></div>
  if (!cur) return (
    <div className="card fast-now"><div className="card-h"><h3>On air now</h3></div>
      <div className="card-b" style={{ color: 'var(--muted)' }}>Nothing is scheduled this minute. Activate the run order, or write the guide ahead under Build.</div></div>)

  const s = Date.parse(cur.start), e = Date.parse(cur.end)
  const durMs = asset?.duration_ms != null ? Number(asset.duration_ms) : null
  // where in the ASSET the channel is: the row's start offset plus time since it began
  const posSec = (cur.inSec ?? 0) + (now - s) / 1000
  const pct = durMs ? Math.min(100, (posSec / (durMs / 1000)) * 100) : Math.min(100, ((now - s) / Math.max(1, e - s)) * 100)
  const m = asset?.metadata ?? {}
  const probe = asset?.ingest?.probe ?? asset?.encode_result?.probe ?? null
  const v = probe?.video ?? (probe?.width ? { width: probe.width, height: probe.height, codec: probe.videoCodec ?? probe.vcodec, fps: probe.fps } : null)
  const au = probe?.audioTracks?.[0] ?? probe?.audio ?? null
  const kept: any[] = Array.isArray(asset?.encode_result?.kept) ? asset.encode_result.kept : []
  const genre = Array.isArray(m.genre) ? m.genre.join(', ') : m.genre
  const ep = m.series ? `${m.series}${m.season != null ? ` · S${m.season}` : ''}${m.episode != null ? `E${m.episode}` : ''}` : null
  const k = ROW_KIND[cur.kind] ?? ROW_KIND.slate
  const poster = posterOf(asset)
  const facts: [string, string | null][] = [
    ['Duration', durMs != null ? mmss(durMs / 1000) : null],
    ['Resolution', v?.width ? `${v.width} × ${v.height}` : null],
    ['Video', [codec(v?.codec), v?.profile, v?.fps ? `${v.fps} fps` : null, kbps(v?.bitrateKbps)].filter(Boolean).join(' · ') || null],
    ['Audio', au ? [codec(au.codec), au.channelLayout ?? (au.channels ? `${au.channels} ch` : null), au.sampleRate ? `${(au.sampleRate / 1000).toFixed(1)} kHz` : null, kbps(au.bitrateKbps)].filter(Boolean).join(' · ') : null],
    ['Renditions', kept.length ? kept.map(r => `${r.height}p${r.bitrate_kbps || r.bitrateKbps ? ` ${kbps(r.bitrate_kbps ?? r.bitrateKbps)}` : ''}`).join(', ') : null],
    ['Formats', [asset?.formats?.hls && 'HLS', asset?.formats?.dash && 'DASH', asset?.formats?.progressive && 'MP4'].filter(Boolean).join(' · ') || null],
    ['Source file', asset?.original_filename ?? null],
  ]
  return (
    <div className="card fast-now">
      <div className="card-h"><h3 style={{ whiteSpace: 'nowrap' }}>On air now</h3><span className={`tag ${k.cls}`}>{k.label}</span>
        {!playing && <span className="sub">scheduled, not sending yet</span>}<span className="spacer" />
        {assetId && <button className="btn ghost sm" onClick={() => navigate(`/vod?asset=${assetId}`)} data-tip="Open this asset in the Media Library" aria-label="Open this asset in the Media Library">Open</button>}</div>
      <div className="card-b">
        <div className="fast-now-hero">
          <div className="fast-now-poster">{poster ? <img src={poster} alt="" /> : <span>{(cur.title || '?').slice(0, 1)}</span>}</div>
          <div style={{ minWidth: 0 }}>
            <div className="fast-now-t">{cur.title}{cur.part === 'resumes' ? <span className="faint"> · continued</span> : null}</div>
            {ep && <div className="fast-now-sub">{ep}</div>}
            <div className="fast-now-sub">{clockOf(cur.start)} – {clockOf(cur.end)} · {mmss((e - now) / 1000)} left in this {cur.kind === 'programme' ? 'part' : 'spot'}</div>
            <div className="fast-now-bar" aria-label="Position in the asset"><i style={{ width: `${pct}%` }} /></div>
            <div className="fast-now-sub mono">{mmss(posSec)}{durMs ? ` / ${mmss(durMs / 1000)}` : ''}</div>
          </div>
        </div>
        {(m.description || genre || m.rating || m.year || m.releaseYear) && (
          <div className="fast-now-meta">
            {m.description && <p>{m.description}</p>}
            <div className="fast-id-tags">
              {genre && <span className="tag type">{genre}</span>}
              {(m.year || m.releaseYear) && <span className="tag idle">{m.year ?? m.releaseYear}</span>}
              {m.rating && <span className="tag idle">{typeof m.rating === 'object' ? m.rating.value ?? JSON.stringify(m.rating) : m.rating}</span>}
              {asset?.schema_name && <span className="tag idle">{asset.schema_name}</span>}
            </div>
          </div>
        )}
        {asset ? <>
          <div className="sec-label" style={{ marginTop: 14 }}>Encode</div>
          <div className="fast-now-facts">
            {facts.filter(([, x]) => x).map(([a, b]) => <div key={a} className="kv"><span className="k">{a}</span><span className="v">{b}</span></div>)}
          </div>
          {asset.ingest?.probe && <>
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setFull(f => !f)} aria-expanded={full}>{full ? 'Hide the source file details' : 'Source file in full'}</button>
            {full && <SourceFacts probe={asset.ingest.probe} bytes={asset.source_bytes} filename={asset.original_filename} mime={asset.mime} />}
          </>}
        </> : assetId ? <div className="loading" style={{ marginTop: 12 }}>Loading the asset…</div>
          : cur.kind === 'break' ? <div className="hintxt" style={{ marginTop: 12 }}>{cur.fill?.map(f => f.title ?? f.kind).join(' · ') || 'Ads'}</div> : null}
        {next && (
          <div className="fast-now-next">
            <span className="faint">Up next</span><b>{next.title}</b><span className="faint">{clockOf(next.start)} · in {mmss((Date.parse(next.start) - now) / 1000)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
//  QC FOR A FAST CHANNEL: what it is doing and what is wrong, in the order a
//  problem shows up. A FAST channel has no source and no encoder, so its gates
//  are its own: a run order on air, a guide written ahead, media ready to air,
//  a playout writing segments, the output manifest answering, something on
//  air this minute, and (when public) the public URL answering.
// ============================================================================
type QcState = 'ok' | 'warn' | 'fail' | 'idle' | 'checking'
interface QcRow { key: string; title: string; state: QcState; detail: string; fix?: string; action?: { label: string; view: 'build' | 'settings' } }
const QC_TAG: Record<QcState, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'live' }, warn: { label: 'Check', cls: 'warn' }, fail: { label: 'Failing', cls: 'down' }, idle: { label: 'Not used', cls: 'idle' }, checking: { label: 'Checking…', cls: 'sched' },
}
const agoS = (iso: string | null | undefined) => { if (!iso) return 'never'; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago` }

async function probeManifest(url: string): Promise<{ ok: boolean; status: number; seq: number | null; note?: string }> {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return { ok: false, status: r.status, seq: null }
    const t = await r.text()
    if (!/#EXTM3U|<MPD/.test(t)) return { ok: false, status: r.status, seq: null, note: 'not a playlist' }
    let seq: number | null = null
    const m = t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)
    if (m) seq = Number(m[1])
    else if (/#EXT-X-STREAM-INF/.test(t)) {
      const v = t.split('\n').find(l => l && !l.startsWith('#'))
      if (v) { const r2 = await fetch(new URL(v.trim(), new URL(url, window.location.href)).toString(), { cache: 'no-store' }); const m2 = (await r2.text()).match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/); if (m2) seq = Number(m2[1]) }
    }
    return { ok: true, status: r.status, seq }
  } catch (e: any) { return { ok: false, status: 0, seq: null, note: String(e?.message ?? e) } }
}

export function FastQcDrawer({ channelId, name, onAir, active, settings, urls, stitched, onClose, onOpen }: {
  channelId: string; name: string; onAir: boolean
  active: { version: number; applied_until: string | null } | null
  settings: FastChannelSettings | null
  urls: { hls: string; dash: string } | null
  stitched: boolean
  onClose: () => void
  onOpen: (v: 'build' | 'settings') => void
}) {
  const [rows, setRows] = useState<QcRow[] | null>(null)
  const [at, setAt] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    const out: QcRow[] = []
    const [c, ready, rd] = await Promise.all([
      fastApi.channel(channelId).catch(() => null),
      fastApi.readiness(channelId).then(r => r.items).catch(() => null),
      fastApi.rundown(channelId, 1).catch(() => null),
    ])
    const p = c?.playout ?? null
    // 1 run order
    out.push(active
      ? { key: 'lineup', title: 'Run order on air', state: 'ok', detail: `Version ${active.version} is active.` }
      : { key: 'lineup', title: 'Run order on air', state: 'fail', detail: 'No run order is active, so the channel has nothing to play.', fix: 'Build the run order and activate it.', action: { label: 'Open Build', view: 'build' } })
    // 2 guide ahead
    if (active) {
      const until = active.applied_until ? Date.parse(active.applied_until) : 0
      const h = (until - Date.now()) / 3600_000
      out.push(h >= 6 ? { key: 'guide', title: 'Guide written ahead', state: 'ok', detail: `Written to ${new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${Math.round(h)} h ahead).` }
        : h > 0 ? { key: 'guide', title: 'Guide written ahead', state: 'warn', detail: `Only ${h.toFixed(1)} h of guide is left.`, fix: 'Rewrite the guide under Build; the scheduler normally keeps it a week ahead.', action: { label: 'Open Build', view: 'build' } }
        : { key: 'guide', title: 'Guide written ahead', state: 'fail', detail: 'The guide has run out: the playout has nothing scheduled.', fix: 'Rewrite the guide under Build.', action: { label: 'Open Build', view: 'build' } })
    }
    // 3 media
    if (ready) {
      const bad = ready.filter(r => r.state !== 'ready')
      out.push(!ready.length ? { key: 'media', title: 'Media ready to air', state: 'idle', detail: 'The run order uses no titles yet.' }
        : !bad.length ? { key: 'media', title: 'Media ready to air', state: 'ok', detail: `All ${ready.length} titles, spots and slates are packaged for air.` }
        : { key: 'media', title: 'Media ready to air', state: bad.some(b => b.state === 'no-source') ? 'fail' : 'warn',
            detail: bad.slice(0, 4).map(b => `${b.title}: ${b.state === 'preparing' ? 'being prepared' : b.state === 'no-source' ? 'source missing' : 'needs preparing'}`).join(' · ') + (bad.length > 4 ? ` · and ${bad.length - 4} more` : ''),
            fix: 'Prepare them from the Media card on the Overview; a missing source has to be uploaded again.' })
    }
    // 4 playout
    const launcher = p?.launcher === 'ecs' ? 'its own ECS task' : p?.launcher === 'local' ? 'this server' : p?.launcher ?? 'nothing yet'
    out.push(!active ? { key: 'playout', title: 'Playout', state: 'idle', detail: 'Starts when a run order is active.' }
      : !p ? { key: 'playout', title: 'Playout', state: 'fail', detail: 'No playout has been started for this channel.', fix: 'The control plane starts it within 30 s of activation. If it never does, the server runs no FAST playouts: restart it with this version (it now runs them on the Mac under the Docker launcher too), or set FAST_LAUNCHER=local.' }
      : p.status === 'failed' ? { key: 'playout', title: 'Playout', state: 'fail', detail: p.error || 'The playout failed to start.', fix: 'Fix the error above; the control plane retries every 30 s.' }
      : p.fresh && p.status === 'running' ? { key: 'playout', title: 'Playout', state: 'ok', detail: `Running on ${launcher}, heard from ${agoS(p.last_seen_at)}, ${p.restarts} restart${p.restarts === 1 ? '' : 's'}.` }
      : p.status === 'starting' && !p.last_seen_at ? { key: 'playout', title: 'Playout', state: 'warn', detail: `Started on ${launcher} ${agoS(p.started_at)} but has not reported yet.`, fix: 'Give it 30 s. Still silent after a minute: the playout process could not reach the API or read its media. Check the control-plane log for [fast] lines.' }
      : { key: 'playout', title: 'Playout', state: 'fail', detail: `Silent since ${agoS(p.last_seen_at)} (on ${launcher}).`, fix: 'The control plane replaces a silent playout after 3 minutes.' })
    if (p?.unreadable?.length) out.push({ key: 'unreadable', title: 'Unreadable media', state: 'warn', detail: `${p.unreadable.length} title(s) are being skipped because their segments cannot be read.`, fix: 'Prepare them again, or take them out of the run order.' })
    // 5 output manifest + advancing
    if (urls && active) {
      const a = await probeManifest(urls.hls)
      let adv: boolean | null = null
      if (a.ok && a.seq != null) { await new Promise(r => setTimeout(r, 4500)); const b = await probeManifest(urls.hls); adv = b.seq != null && b.seq > (a.seq ?? 0) }
      out.push(!a.ok ? { key: 'output', title: 'Output manifest', state: 'fail', detail: `The channel's HLS ${a.status ? `answers ${a.status}` : 'cannot be reached'}${a.note ? ` (${a.note})` : ''}.`, fix: 'Nothing is being written: see Playout above.' }
        : adv === false ? { key: 'output', title: 'Output manifest', state: 'warn', detail: `The playlist answers but did not advance in 4.5 s (media sequence ${a.seq}).`, fix: 'The playout may be stuck: see Playout above.' }
        : { key: 'output', title: 'Output manifest', state: 'ok', detail: `HLS answering and advancing${a.seq != null ? ` (media sequence ${a.seq})` : ''}.` })
    }
    // 6 on air now
    const now = Date.now()
    const cur = rd?.items.find(r => Date.parse(r.start) <= now && Date.parse(r.end) > now)
    if (active) out.push(cur ? { key: 'now', title: 'On air this minute', state: 'ok', detail: `${cur.title} (${cur.kind}) until ${new Date(cur.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` }
      : { key: 'now', title: 'On air this minute', state: 'warn', detail: 'The timeline has nothing scheduled now: the playout plays the slate.', fix: 'Rewrite the guide under Build.', action: { label: 'Open Build', view: 'build' } })
    // 7 public
    if (onAir) {
      const pub = await probeManifest(`/live/${channelId}/master.m3u8`)
      out.push(pub.ok ? { key: 'public', title: 'Public URL', state: 'ok', detail: 'Viewers can play the channel from its public address.' }
        : { key: 'public', title: 'Public URL', state: 'fail', detail: `The public address answers ${pub.status || 'nothing'}.`, fix: 'The channel is set live but the public address does not serve it: see Playout and Output above.' })
    } else out.push({ key: 'public', title: 'Public URL', state: 'idle', detail: 'Private: only the console can play it. Go live to open it to viewers.' })
    // 8 watermark, ads
    const wm = settings?.watermark
    out.push(wm?.enabled && wm.ref ? { key: 'wm', title: 'Watermark', state: 'ok', detail: 'On: drawn by Volt players, embeds and share links.' }
      : wm?.enabled ? { key: 'wm', title: 'Watermark', state: 'warn', detail: 'Turned on without an image.', fix: 'Choose the image in Settings.', action: { label: 'Open Settings', view: 'settings' } }
      : { key: 'wm', title: 'Watermark', state: 'idle', detail: 'Off.', action: { label: 'Open Settings', view: 'settings' } })
    out.push({ key: 'ads', title: 'Ads', state: c?.ads ? (c.ads.mode === 'stitched' && !c.ads.adServerId && !c.ads.house?.length ? 'warn' : c.ads.mode === 'off' ? 'idle' : 'ok') : 'idle',
      detail: !c?.ads || c.ads.mode === 'off' ? 'No ad breaks.' : c.ads.mode === 'markers' ? 'Breaks are marked (SCTE-35) with house spots in them.' : stitched ? `Stitched per viewer${c.ads.adServerId ? ' from the ad server' : ''}${c.ads.house?.length ? `, ${c.ads.house.length} house spot(s) as fallback` : ''}.` : 'Stitched.',
      fix: c?.ads?.mode === 'stitched' && !c.ads.adServerId && !c.ads.house?.length ? 'No ad server and no house spots: breaks play the slate.' : undefined })
    setRows(out); setAt(Date.now()); setBusy(false)
  }
  useEffect(() => { run() }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps
  const worst = (rows ?? []).some(r => r.state === 'fail') ? 'fail' : (rows ?? []).some(r => r.state === 'warn') ? 'warn' : 'ok'
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="drawer fast-qc" role="dialog" aria-modal="true" aria-label={`QC for ${name}`}>
        <div className="drawer-h"><div className="t">QC · {name}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          {!rows ? <div className="loading">Checking the channel…</div> : <>
            <div className={`fast-qc-sum ${worst}`}>
              <b>{worst === 'fail' ? 'Something is stopping the channel.' : worst === 'warn' ? 'The channel runs, with things to check.' : 'Everything checks out.'}</b>
              <span>Checked {new Date(at).toLocaleTimeString()} · <button className="lnkbtn" onClick={run} disabled={busy}>{busy ? 'checking…' : 'check again'}</button></span>
            </div>
            {rows.map(r => (
              <div key={r.key} className="fast-qc-row">
                <span className={`tag ${QC_TAG[r.state].cls}`}>{QC_TAG[r.state].label}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{r.title}</div>
                  <div className="d">{r.detail}</div>
                  {r.fix && r.state !== 'ok' && <div className="f">{r.fix}</div>}
                </div>
                {r.action && r.state !== 'ok' ? <button className="btn ghost sm" onClick={() => onOpen(r.action!.view)}>{r.action.label}</button> : <span />}
              </div>
            ))}
          </>}
        </div>
      </div>
    </div>
  )
}


// ============================================================================
//  FILLER FROM LOOPS & FILLERS: the channel's slate (unsold ad breaks and
//  gaps) and gap loop, picked from the same slates and loops live channels use
//  when their source drops. Rendered once into a broadcast-shaped asset and
//  prepared for air by the API (services/fast/fillerBridge.ts).
// ============================================================================
export function FastFillerCard({ channelId }: { channelId: string }) {
  const notify = useNotify()
  const [ads, setAds] = useState<ChannelAds | null>(null)
  const [items, setItems] = useState<FillerAsset[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fastApi.ads(channelId).then(setAds).catch(() => {})
    api.fillerAssets().then(setItems).catch(() => setItems([]))
  }, [channelId])
  if (!ads || !items) return <div className="card"><div className="card-b loading">Loading filler…</div></div>
  const src = ads.filler?.sources ?? {}
  const slateFiller = ads.policy && (ads.policy as any).slateAssetId ? src[(ads.policy as any).slateAssetId] ?? null : null
  const slateFromLibrary = !!(ads.policy as any)?.slateAssetId && !slateFiller
  const loopFiller = ads.brand?.loopAssetId ? src[ads.brand.loopAssetId] ?? null : null
  const loopFromLibrary = !!ads.brand?.loopAssetId && !loopFiller
  const ready = items.filter(i => i.status === 'ready')
  const save = async (b: { slateFillerId?: string | null; loopFillerId?: string | null; breaksUseLoop?: boolean }, what: string) => {
    setBusy(true)
    try {
      const r = await fastApi.saveFiller(channelId, b)
      setAds(r)
      notify({ kind: 'ok', title: `${what} saved.`, message: r.prepared?.queued?.length ? 'It is being prepared for air (about a minute); the playout picks it up after that.' : 'The playout picks it up within a minute.' })
    } catch (e: any) { notify({ kind: 'error', title: `Couldn't set the ${what.toLowerCase()}.`, message: e.message }) } finally { setBusy(false) }
  }
  const dur = (ms: any) => { const s = Math.round(Number(ms) / 1000); return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '' }
  const label = (f: FillerAsset) => `${f.name}${f.kind === 'loop' && f.duration_ms ? ` · ${dur(f.duration_ms)}` : ''}`
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-h"><h3>Filler</h3><span className="sub">from Loops &amp; Fillers: what plays when nothing else does</span><span className="spacer" />
        <button className="btn ghost sm" onClick={() => navigate('/loops')}>Manage</button></div>
      <div className="card-b">
        {!ready.length && <Notice kind="info" variant="compact" message="No slates or loops yet. Upload one under Loops & Fillers (an image for a slate, a short video for a loop)." />}
        <div className="fast-filler">
          <div className="field">
            <label>Slate</label>
            <select className="inp" value={slateFiller ?? (slateFromLibrary ? '__lib' : '')} disabled={busy}
              onChange={e => { const v = e.target.value; if (v !== '__lib') save({ slateFillerId: v || null }, 'Slate') }}>
              <option value="">{slateFromLibrary ? 'None' : 'None: the default black slate'}</option>
              {slateFromLibrary && <option value="__lib">A library asset (set under Ads)</option>}
              {ready.filter(f => f.kind === 'slate').length > 0 && <optgroup label="Slates">{ready.filter(f => f.kind === 'slate').map(f => <option key={f.id} value={f.id}>{label(f)}</option>)}</optgroup>}
              {ready.filter(f => f.kind === 'loop').length > 0 && <optgroup label="Loops">{ready.filter(f => f.kind === 'loop').map(f => <option key={f.id} value={f.id}>{label(f)}</option>)}</optgroup>}
            </select>
            <div className="hintxt">Plays in ad breaks nobody sold, and in gaps when there is no loop. A still slate becomes 10 s of picture with silence and repeats.</div>
          </div>
          <div className="field">
            <label>Gap loop</label>
            <select className="inp" value={loopFiller ?? (loopFromLibrary ? '__lib' : '')} disabled={busy}
              onChange={e => { const v = e.target.value; if (v !== '__lib') save({ loopFillerId: v || null }, 'Loop') }}>
              <option value="">None: gaps show the slate</option>
              {loopFromLibrary && <option value="__lib">The brand loop (set under Brand loop)</option>}
              {ready.filter(f => f.kind === 'loop').map(f => <option key={f.id} value={f.id}>{label(f)}</option>)}
            </select>
            <div className="hintxt">Fills the gaps between programmes (grid padding, the daily restart) in the slate's place, with or without idents. Up to 2 minutes, repeated as needed.</div>
          </div>
        </div>
        <label className="fast-filler-chk">
          <input type="checkbox" checked={!!ads.filler?.breaksUseLoop} disabled={busy || !ads.brand?.loopAssetId}
            onChange={e => save({ breaksUseLoop: e.target.checked }, 'Break filler')} />
          Play the loop in unsold ad breaks too, instead of the slate
        </label>
      </div>
    </div>
  )
}
