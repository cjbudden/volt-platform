import { useEffect, useMemo, useState } from 'react'
import { api, thumbUrl, type Group } from '../api'
import { subscribeLive } from '../liveStatus'
import { useProtocols, protoOf, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'

type Props = {
  createOpen: boolean; setCreateOpen: (v: boolean) => void; onOpen?: (id: string) => void
  /** 'radio' is the same page at the audio-only scope: audio channels, audio ladder. */
  mode?: 'video' | 'radio'
}

const WATERMARK_POS: { id: 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc'; label: string }[] = [
  { id: 'tl', label: 'Top left' }, { id: 'tc', label: 'Top centre' }, { id: 'tr', label: 'Top right' },
  { id: 'bl', label: 'Bottom left' }, { id: 'bc', label: 'Bottom centre' }, { id: 'br', label: 'Bottom right' },
]
const AUDIO_PRESETS = [
  { label: 'High', bitrateKbps: 128 }, { label: 'Standard', bitrateKbps: 96 },
  { label: 'Low', bitrateKbps: 64 }, { label: 'Mobile', bitrateKbps: 48 },
]

type RetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
const RET_UNIT_SEC: Record<RetUnit, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }
export function splitDuration(sec: number | null): { n: string; unit: RetUnit } {
  if (sec == null || sec <= 0) return { n: '', unit: 'days' }
  const order: RetUnit[] = ['months', 'weeks', 'days', 'hours', 'minutes']
  for (const u of order) { const s = RET_UNIT_SEC[u]; if (sec % s === 0 && sec >= s) return { n: String(sec / s), unit: u } }
  return { n: String(Math.max(1, Math.round(sec / 60))), unit: 'minutes' }
}

/** Format retention for the list: prefer the real seconds value (minutes..months),
 *  fall back to the legacy days field. e.g. 3600s -> "1h", not "1d". */
function fmtRetention(sec?: number | null, days?: number | null): string {
  if (sec != null && sec > 0) {
    for (const [u, l] of [[2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']] as [number, string][]) {
      if (sec % u === 0 && sec >= u) return `${sec / u}${l}`
    }
    return `${Math.max(1, Math.round(sec / 60))}m`
  }
  return days != null && days > 0 ? `${days}d` : '—'
}

export default function Channels({ createOpen, setCreateOpen, onOpen, mode = 'video' }: Props) {
  const radio = mode === 'radio'
  const [channels, setChannels] = useState<any[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [filter, setFilter] = useState<'all' | 'transcode' | 'package_only'>('all')

  async function load() {
    const [chs, gs] = await Promise.all([api.channels(), api.groups()])
    const gmap = new Map(gs.map(g => [g.id, g]))
    // one list, two lenses: Channels is video, Radio is audio-only
    setChannels(chs.filter(c => !!c.audio_only === radio).map(c => ({ ...c, _g: gmap.get(c.group_id) })))
    setGroups(gs)
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [radio])
  // live: refresh the list on any stream status/event change (one shared SSE socket)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const refetch = () => { if (t) return; t = setTimeout(() => { t = null; load() }, 500) }
    const unsub = subscribeLive('*', refetch)
    return () => { if (t) clearTimeout(t); unsub() }
  }, [])
  // ground-truth transitions (e.g. Starting -> Ready when the manifest starts advancing)
  // aren't always a discrete SSE event, so reconcile gently so the list stays honest+live.
  useEffect(() => {
    const iv = setInterval(() => load(), 6000)
    return () => clearInterval(iv)
  }, [])

  const shown = useMemo(() => {
    if (!channels) return channels
    if (filter === 'all') return channels
    return channels.filter(c => c._g?.workflow_type === filter)
  }, [channels, filter])

  const counts = useMemo(() => {
    const c = channels || []
    return {
      all: c.length,
      transcode: c.filter(x => x._g?.workflow_type === 'transcode').length,
      package_only: c.filter(x => x._g?.workflow_type === 'package_only').length,
    }
  }, [channels])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{radio ? 'Radio' : 'Channels'}</h1>
          <p>{radio
            ? 'Audio-only stations. One source in, an AAC ladder out — no video anywhere in the chain.'
            : '24×7 live channels. Transcode builds the rendition ladder for you; packaging takes a pre-encoded ladder.'}</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
          {radio ? 'New station' : 'New channel'}
        </button>
      </div>

      {channels === null ? (
        <div className="loading">Loading channels…</div>
      ) : channels.length === 0 ? (
        <EmptyState radio={radio} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          {!radio && (
            <div className="filters">
              <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
              <FChip label="Transcode" n={counts.transcode} on={filter === 'transcode'} onClick={() => setFilter('transcode')} />
              <FChip label="Packaging" n={counts.package_only} on={filter === 'package_only'} onClick={() => setFilter('package_only')} />
            </div>
          )}
          <ChannelTable channels={shown || []} radio={radio} onChanged={load} onOpen={onOpen} />
        </>
      )}

      {createOpen && (
        <CreateChannel groups={groups} radio={radio} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load() }} />
      )}
    </>
  )
}

function FChip({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <div className={`chip ${on ? 'active' : ''}`} onClick={onClick}>
      {label}<span className="ct">{n}</span>
    </div>
  )
}

function EmptyState({ onCreate, radio }: { onCreate: () => void; radio?: boolean }) {
  return (
    <div className="empty">
      <div className="ic">
        {radio
          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><circle cx="8" cy="15.5" r="2.5" /><path d="M17 14h2M17 17h2M18 3 7 8" /></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>}
      </div>
      <h3>{radio ? 'No stations yet' : 'No channels yet'}</h3>
      <p>{radio
        ? 'Create your first radio station. Point it at an audio source — Icecast, SRT, RTMP or HLS — and we encode an AAC ladder and package it for players. No video is produced.'
        : 'Create your first channel to start a live stream. You can make a transcode channel — we build the ABR ladder — or a packaging channel, where you send a pre-encoded ladder and we package it.'}</p>
      <button className="btn primary" onClick={onCreate} style={{ margin: '0 auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
        {radio ? 'Create your first station' : 'Create your first channel'}
      </button>
    </div>
  )
}

const THUMB_BG = ['linear-gradient(135deg,#7dd3fc,#3f7bff)', 'linear-gradient(135deg,#4ade80,#16a34a)', 'linear-gradient(135deg,#c4b5fd,#7c3aed)', 'linear-gradient(135deg,#fca5a5,#ef4444)', 'linear-gradient(135deg,#fdba74,#f97316)']
function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

function ChannelTable({ channels, onChanged, onOpen, radio }: { channels: any[]; onChanged: () => void; onOpen?: (id: string) => void; radio?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  async function toggle(c: any) {
    setBusy(c.id)
    try { await api.startStop(c.id, c.status === 'live' ? 'stop' : 'start'); await onChanged() }
    finally { setBusy(null) }
  }
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>{radio ? 'Station' : 'Channel'}</th>
            <th>Type</th>
            <th>{radio ? 'Audio ladder' : 'Renditions'}</th>
            <th>Status</th>
            <th>Retention</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c, i) => {
            const wt = c._g?.workflow_type
            const live = c.status === 'live'
            return (
              <tr key={c.id} onClick={() => onOpen?.(c.id)} style={onOpen ? { cursor: 'pointer' } : undefined}>
                <td>
                  <div className="cell-name">
                    {c.brand_ref
                      ? <img className="thumb" src={thumbUrl(c.brand_ref, 80, 80)} alt="" style={{ objectFit: 'cover', background: '#0b0f16' }} />
                      : <div className="thumb" style={{ background: THUMB_BG[i % THUMB_BG.length] }}>{initials(c.name)}</div>}
                    <div>
                      <div className="nm">{c.name}</div>
                      <div className="id">{c._g?.name || '—'}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {c.audio_only
                    ? <span className="tag type loop">Radio</span>
                    : <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>
                        {wt === 'transcode' ? 'Transcode' : wt === 'package_only' ? 'Packaging' : '—'}
                      </span>}
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {c.audio_only
                    ? (c.audio_ladder || []).map((r: any) => `${r.bitrate_kbps}k`).join(' · ') || '128k · 64k'
                    : wt === 'transcode'
                    ? ((c.output_ladder && c.output_ladder.length ? c.output_ladder : c._g?.rungs) || []).map((r: any) => `${r.height}p`).join(' · ') || '—'
                    : 'source ladder'}
                </td>
                <td>
                  {(() => {
                    const ps = c.pipelineState
                    // same overall roll-up as the detail page — one consistent status.
                    const map: Record<string, { label: string; cls: string }> = {
                      onair: { label: 'On air', cls: 'live' },
                      ready: { label: 'Ready', cls: 'sched' },
                      starting: { label: 'Starting', cls: 'sched' },
                      degraded: { label: 'Degraded', cls: 'warn' },
                      error: { label: 'Error', cls: 'down' },
                      stopped: { label: 'Stopped', cls: 'idle' },
                      idle: { label: 'Idle', cls: 'idle' },
                    }
                    const m = (ps && map[ps]) || (live ? map.starting : c.status === 'scheduled' ? { label: 'Scheduled', cls: 'sched' } : map.idle)
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`tag ${m.cls}`}><span className={`dot-s ${m.cls}`} />{m.label}</span>
                        {c.billable && <span title="encoder up (billable)" style={{ fontSize: 10, color: '#fbbf24' }}>● billable</span>}
                      </div>
                    )
                  })()}
                </td>
                <td style={{ color: 'var(--muted)' }}>{fmtRetention(c.recording_retention_sec, c.recording_retention_days)}</td>
                <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                  <button className={`btn ${live ? 'ghost' : 'primary'}`} disabled={busy === c.id} onClick={() => toggle(c)}>
                    {busy === c.id ? '…' : live ? 'Stop' : 'Start'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const RUNG_PRESETS = [
  { height: 1080, bitrateKbps: 5000 }, { height: 720, bitrateKbps: 2800 },
  { height: 480, bitrateKbps: 1200 }, { height: 360, bitrateKbps: 800 }, { height: 240, bitrateKbps: 400 },
]
const SEC: React.CSSProperties = { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', margin: '20px 0 10px', fontWeight: 700 }
type PkgRow = { label: string; bitrateKbps: number; protocol: string; url: string; backupUrl: string }

function CreateChannel({ groups, onClose, onCreated, radio }: { groups: Group[]; onClose: () => void; onCreated: () => void; radio?: boolean }) {
  const byType = useMemo(() => ({
    transcode: groups.find(g => g.workflow_type === 'transcode'),
    package_only: groups.find(g => g.workflow_type === 'package_only'),
  }), [groups])
  const [type, setType] = useState<'transcode' | 'package_only'>('transcode')
  const [name, setName] = useState('')
  const [purchasing, setPurchasing] = useState('reserved')
  const [retNum, setRetNum] = useState<string>('7')
  const [retUnit, setRetUnit] = useState<RetUnit>('days')
  const [dvrMin, setDvrMin] = useState(60)
  const DVR_MAX_MIN = 240

  const protocols = useProtocols()
  // transcode: single source + optional backup + selectable ladder
  const [tSrc, setTSrc] = useState<SourceValue>({ protocol: 'srt', url: '' })
  const [tBackupOn, setTBackupOn] = useState(false)
  const [tBackup, setTBackup] = useState<SourceValue>({ protocol: 'srt', url: '' })
  const [ladder, setLadder] = useState(() => RUNG_PRESETS.map(r => ({ ...r, on: [1080, 720, 480].includes(r.height) })))

  // package: per-rendition input rows + fallback
  const [rows, setRows] = useState<PkgRow[]>([
    { label: '1080p', bitrateKbps: 5000, protocol: 'hls', url: '', backupUrl: '' },
    { label: '720p', bitrateKbps: 2800, protocol: 'hls', url: '', backupUrl: '' },
    { label: '480p', bitrateKbps: 1200, protocol: 'hls', url: '', backupUrl: '' },
  ])
  const [fallbackMode, setFallbackMode] = useState<'none' | 'matching' | 'single'>('none')
  const [fbSrc, setFbSrc] = useState<SourceValue>({ protocol: 'hls', url: '' })

  // brand: the station logo/artwork. Identity for the console, the guide and public
  // metadata — and the artwork a radio player shows. NOT burned into the video.
  const [brandRef, setBrandRef] = useState('')
  const [description, setDescription] = useState('')
  const [brandPickerOpen, setBrandPickerOpen] = useState(false)

  // watermark: burned into the transcode output (a different thing to the brand above)
  const [wmOn, setWmOn] = useState(false)
  const [wmRef, setWmRef] = useState('')
  const [wmPos, setWmPos] = useState<'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc'>('br')
  const [wmScale, setWmScale] = useState(12)
  const [wmOpacity, setWmOpacity] = useState(100)
  const [wmMargin, setWmMargin] = useState(24)
  const [wmPickerOpen, setWmPickerOpen] = useState(false)

  // audio-only (radio): an AAC ladder instead of a video one
  const [audio, setAudio] = useState(() => AUDIO_PRESETS.map(a => ({ ...a, on: a.bitrateKbps === 128 || a.bitrateKbps === 64 })))
  const [aSrc, setASrc] = useState<SourceValue>({ protocol: 'srt', url: '' })

  // filler on total loss (both flows)
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>('slate')
  const [slateRef, setSlateRef] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loopPickerOpen, setLoopPickerOpen] = useState(false)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const group = radio ? (byType.transcode ?? byType.package_only ?? groups[0]) : byType[type]

  function setRow(i: number, patch: Partial<PkgRow>) { setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r)) }
  function addRow() { setRows(rs => [...rs, { label: '', bitrateKbps: 1000, protocol: 'hls', url: '', backupUrl: '' }]) }
  function delRow(i: number) { setRows(rs => rs.filter((_, j) => j !== i)) }
  const heightFromLabel = (l: string) => parseInt(l, 10) || 0

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the channel a name'); return }
    if (!group) { setErr(radio ? 'No group set up yet to hold stations' : `No ${type === 'transcode' ? 'transcode' : 'packaging'} group set up yet`); return }

    const sources: NonNullable<Parameters<typeof api.createChannel>[0]['sources']> = []
    let outputLadder: { height: number; bitrateKbps: number }[] = []
    let fallbackTranscode = false

    if (radio) {
      if (!aSrc.url.trim()) { setErr('Add the audio source URL'); return }
      const rungs = audio.filter(a => a.on)
      if (!rungs.length) { setErr('Select at least one audio rendition'); return }
      sources.push({ role: 'primary', protocol: aSrc.protocol, ingestUrl: aSrc.url.trim(), streamKey: aSrc.streamKey?.trim() || undefined })
      setBusy(true)
      try {
        await api.createChannel({
          groupId: group!.id, name: name.trim(), purchasingMode: purchasing, resilienceTier: 'standard',
          recordingRetentionSec: retNum ? Math.max(Number(retNum) * RET_UNIT_SEC[retUnit], dvrMin * 60) : null,
          dvrWindowSec: Math.max(30, dvrMin * 60), dvrMode: 'sliding',
          sources, audioOnly: true,
          audioLadder: rungs.map(a => ({ label: a.label, bitrateKbps: a.bitrateKbps })),
          brandRef: brandRef.trim() || null, description: description.trim() || null,
          inputLossBehavior: lossBehavior === 'slate' || lossBehavior === 'last_frame' ? 'none' : lossBehavior,
        })
        onCreated()
      } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
      return
    }

    if (type === 'transcode') {
      if (!tSrc.url.trim()) { setErr('Add the primary source URL'); return }
      const rungs = ladder.filter(r => r.on)
      if (!rungs.length) { setErr('Select at least one output rendition'); return }
      outputLadder = rungs.map(r => ({ height: r.height, bitrateKbps: r.bitrateKbps }))
      sources.push({ role: 'primary', protocol: tSrc.protocol, ingestUrl: tSrc.url.trim(), streamKey: tSrc.streamKey?.trim() || undefined })
      if (tBackupOn && tBackup.url.trim()) sources.push({ role: 'backup', protocol: tBackup.protocol, ingestUrl: tBackup.url.trim(), streamKey: tBackup.streamKey?.trim() || undefined })
    } else {
      const filled = rows.filter(r => r.url.trim() && r.label.trim())
      if (!filled.length) { setErr('Add at least one rendition input (label + URL)'); return }
      outputLadder = filled.map(r => ({ height: heightFromLabel(r.label), bitrateKbps: r.bitrateKbps }))
      for (const r of filled) sources.push({ role: 'primary', protocol: r.protocol, ingestUrl: r.url.trim(), renditionLabel: r.label.trim(), renditionBitrateKbps: r.bitrateKbps })
      if (fallbackMode === 'matching') {
        for (const r of filled) if (r.backupUrl.trim()) sources.push({ role: 'backup', protocol: r.protocol, ingestUrl: r.backupUrl.trim(), renditionLabel: r.label.trim(), renditionBitrateKbps: r.bitrateKbps })
      } else if (fallbackMode === 'single') {
        if (!fbSrc.url.trim()) { setErr('Add the single fallback source URL'); return }
        sources.push({ role: 'backup', protocol: fbSrc.protocol, ingestUrl: fbSrc.url.trim(), streamKey: fbSrc.streamKey?.trim() || undefined })
        fallbackTranscode = true // one source, transcoded up to all matching bitrates
      }
    }

    setBusy(true)
    try {
      await api.createChannel({
        groupId: group.id, name: name.trim(), purchasingMode: purchasing,
        resilienceTier: 'standard',
        recordingRetentionSec: retNum ? Math.max(Number(retNum) * RET_UNIT_SEC[retUnit], dvrMin * 60) : null,
        dvrWindowSec: Math.max(30, dvrMin * 60), dvrMode: 'sliding',
        outputLadder, sources,
        inputFailoverEnabled: sources.some(s => s.role === 'backup'),
        inputLossBehavior: lossBehavior,
        fillerSlateRef: (lossBehavior === 'slate' || lossBehavior === 'vod_loop') && slateRef.trim() ? slateRef.trim() : null,
        fallbackTranscode,
        brandRef: brandRef.trim() || null,
        description: description.trim() || null,
        watermark: wmOn && wmRef.trim()
          ? { enabled: true, ref: wmRef.trim(), position: wmPos, offsetX: wmMargin, offsetY: wmMargin, opacity: wmOpacity, scale: wmScale }
          : undefined,
      })
      onCreated()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{radio ? 'New radio station' : 'New channel'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>{radio ? 'Station name' : 'Channel name'}</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder={radio ? 'e.g. RTM Klasik FM' : 'e.g. RTM News 24'} />
          </div>

          {/* BRAND — the station's identity. Shown in the console, the programme guide
              and public metadata, and used as the artwork on an audio-only player. */}
          <div style={SEC}>Brand</div>
          <div className="field">
            <label>{radio ? 'Station artwork' : 'Channel logo'} <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— shown in the guide and channel info</span></label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ width: 52, height: 52, borderRadius: 11, flex: 'none', overflow: 'hidden', background: 'var(--panel-2)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
                {brandRef
                  ? <img src={thumbUrl(brandRef, 104, 104)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <svg viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="1.7" style={{ width: 22, height: 22 }}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.8" /><path d="m21 15-5-5L5 21" /></svg>}
              </div>
              <input className="inp" value={brandRef} onChange={e => setBrandRef(e.target.value)} placeholder="Pick from the library, upload, or paste a URL" />
              <button type="button" className="btn ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setBrandPickerOpen(true)}>Browse / upload…</button>
            </div>
            <div className="hintxt">Not burned into the picture — this is identity, not an overlay.{!radio && ' Use the watermark below to burn a logo into the video.'}</div>
          </div>
          <div className="field">
            <label>Description <span style={{ color: 'var(--faint)', fontWeight: 500 }}>— optional</span></label>
            <textarea className="inp" rows={2} style={{ resize: 'vertical' }} value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={radio ? 'Classic hits, 24 hours a day.' : 'What this channel carries — shown in the guide.'} />
          </div>
          <ImagePicker open={brandPickerOpen} kinds={['brand', 'poster', 'slate', 'other']}
            title={radio ? 'Choose or upload station artwork' : 'Choose or upload a channel logo'}
            uploadKind="brand" uploadFolder="brands"
            onClose={() => setBrandPickerOpen(false)} onPick={(url) => { setBrandRef(url); setBrandPickerOpen(false) }} />

          {!radio && (
            <div className="field"><label>Type</label>
              <div className="presets">
                <Preset sel={type === 'transcode'} onClick={() => setType('transcode')} title="Transcode"
                  desc="One source in. We build the ABR ladder with FFmpeg." meta="1 input → many outputs" />
                <Preset sel={type === 'package_only'} onClick={() => setType('package_only')} title="Packaging"
                  desc="You send a pre-encoded ladder; we just package it." meta="N inputs → N outputs" />
              </div>
            </div>
          )}

          {radio ? (
            <>
              <div style={SEC}>Source</div>
              <SourceInput protocols={protocols} value={aSrc} onChange={setASrc} label="Audio source" />
              <div className="hintxt" style={{ marginTop: -6 }}>Any audio-bearing input works — Icecast, SRT, RTMP or HLS. Video in the source is discarded.</div>

              <div style={SEC}>Audio ladder</div>
              <div className="field">
                {audio.map((a, i) => (
                  <div key={a.bitrateKbps} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div className={`selchip ${a.on ? 'sel' : ''}`} style={{ minWidth: 96, justifyContent: 'center' }}
                      onClick={() => setAudio(l => l.map((x, j) => j === i ? { ...x, on: !x.on } : x))}>{a.label}</div>
                    <input className="inp" style={{ maxWidth: 130, opacity: a.on ? 1 : 0.45 }} disabled={!a.on} inputMode="numeric"
                      value={a.bitrateKbps}
                      onChange={e => setAudio(l => l.map((x, j) => j === i ? { ...x, bitrateKbps: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } : x))} />
                    <span style={{ fontSize: 12, color: 'var(--faint)' }}>kbps AAC</span>
                  </div>
                ))}
                <div className="hintxt">Each selected rung is encoded from the source and packaged as an audio-only HLS/DASH rendition.</div>
              </div>
            </>
          ) : type === 'transcode' ? (
            <>
              <div style={SEC}>Source</div>
              <SourceInput protocols={protocols} value={tSrc} onChange={setTSrc} label="Primary source" />
              <div className="toggle-row">
                <div><div className="tt">Backup source</div><div className="td">Optional failover input of the same feed.</div></div>
                <div className={`sw ${tBackupOn ? '' : 'off'}`} onClick={() => setTBackupOn(v => !v)}><i /></div>
              </div>
              {tBackupOn && <SourceInput protocols={protocols} value={tBackup} onChange={setTBackup} label="Backup source" />}

              <div style={SEC}>Output rendition ladder</div>
              <div className="field">
                {ladder.map((r, i) => (
                  <div key={r.height} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div className={`selchip ${r.on ? 'sel' : ''}`} style={{ minWidth: 78, justifyContent: 'center' }}
                      onClick={() => setLadder(l => l.map((x, j) => j === i ? { ...x, on: !x.on } : x))}>{r.height}p</div>
                    <input className="inp" style={{ maxWidth: 130, opacity: r.on ? 1 : 0.45 }} disabled={!r.on}
                      value={r.bitrateKbps} onChange={e => setLadder(l => l.map((x, j) => j === i ? { ...x, bitrateKbps: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } : x))} />
                    <span style={{ fontSize: 12, color: 'var(--faint)' }}>kbps</span>
                  </div>
                ))}
                <div className="hintxt">We encode the single source into every selected rendition.</div>
              </div>
            </>
          ) : (
            <>
              <div style={SEC}>Sent renditions (your pre-encoded ladder)</div>
              <div className="field">
                {rows.map((r, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 11, padding: 11, marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <input className="inp" style={{ width: 90 }} value={r.label} onChange={e => setRow(i, { label: e.target.value })} placeholder="1080p" />
                      <input className="inp" style={{ width: 110 }} value={r.bitrateKbps} onChange={e => setRow(i, { bitrateKbps: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })} placeholder="kbps" />
                      <select className="inp" style={{ width: 100 }} value={r.protocol} onChange={e => setRow(i, { protocol: e.target.value })}>{protocols.filter(p => p.packageFriendly).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
                      {rows.length > 1 && <button className="xbtn" onClick={() => delRow(i)} title="Remove">✕</button>}
                    </div>
                    <input className="inp" value={r.url} onChange={e => setRow(i, { url: e.target.value })} placeholder={protoOf(protocols, r.protocol).urlPlaceholder} />
                    {fallbackMode === 'matching' && (
                      <input className="inp" style={{ marginTop: 8 }} value={r.backupUrl} onChange={e => setRow(i, { backupUrl: e.target.value })} placeholder="backup https://…/1080p.m3u8" />
                    )}
                  </div>
                ))}
                <button className="chip" onClick={addRow}>+ Add rendition</button>
                <div className="hintxt">Each rendition is packaged 1:1 to the matching output. Height is read from the label (e.g. 1080p).</div>
              </div>

              <div style={SEC}>Fallback</div>
              <div className="field"><label>On source loss</label>
                <select className="inp" value={fallbackMode} onChange={e => setFallbackMode(e.target.value as any)}>
                  <option value="none">None</option>
                  <option value="matching">Matching backup URLs (per rendition)</option>
                  <option value="single">Single fallback source → transcode to all bitrates</option>
                </select>
              </div>
              {fallbackMode === 'single' && (
                <>
                  <SourceInput protocols={protocols} value={fbSrc} onChange={setFbSrc} label="Fallback source" />
                  <div className="hintxt" style={{ marginTop: -6 }}>Transcoded up to every rendition bitrate so all outputs stay continuous.</div>
                </>
              )}
            </>
          )}

          {!radio && (
            <>
              <div style={SEC}>Watermark</div>
              <div className="toggle-row">
                <div><div className="tt">Burn a logo into the output</div><div className="td">Transcode channels only — packaging copies the source untouched.</div></div>
                <div className={`sw ${wmOn ? '' : 'off'}`} onClick={() => setWmOn(v => !v)}><i /></div>
              </div>
              {wmOn && (
                <>
                  <div className="field"><label>Watermark image</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      {wmRef && <img src={thumbUrl(wmRef, 92, 68)} alt="" style={{ width: 46, height: 34, objectFit: 'contain', borderRadius: 6, background: '#0b0f16', flex: 'none' }} />}
                      <input className="inp" value={wmRef} onChange={e => setWmRef(e.target.value)} placeholder="Pick a logo, upload, or paste a URL" />
                      <button type="button" className="btn ghost" onClick={() => setWmPickerOpen(true)}>Browse / upload…</button>
                    </div>
                    <div className="hintxt">A transparent PNG works best.</div>
                  </div>
                  <div className="field"><label>Position</label>
                    <div className="chipset">
                      {WATERMARK_POS.map(p => (
                        <div key={p.id} className={`selchip ${wmPos === p.id ? 'sel' : ''}`} onClick={() => setWmPos(p.id)}>{p.label}</div>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>Size — {wmScale}% of frame height</label>
                    <input type="range" min={2} max={40} value={wmScale} onChange={e => setWmScale(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
                  </div>
                  <div className="field">
                    <label>Opacity — {wmOpacity}%</label>
                    <input type="range" min={10} max={100} value={wmOpacity} onChange={e => setWmOpacity(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
                  </div>
                  <div className="field">
                    <label>Margin from the edge — {wmMargin}px</label>
                    <input type="range" min={0} max={200} value={wmMargin} onChange={e => setWmMargin(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
                  </div>
                  <ImagePicker open={wmPickerOpen} kinds={['brand', 'watermark', 'other']} title="Choose or upload a watermark"
                    uploadKind="brand" uploadFolder="brands"
                    onClose={() => setWmPickerOpen(false)} onPick={(url) => { setWmRef(url); setWmPickerOpen(false) }} />
                </>
              )}
            </>
          )}

          <div style={SEC}>Filler on total loss</div>
          <div className="field"><label>When no source is available</label>
            <select className="inp" value={lossBehavior} onChange={e => setLossBehavior(e.target.value as any)}>
              <option value="none">None (output stops)</option>
              <option value="slate">Slate image</option>
              <option value="vod_loop">Loop video</option>
              <option value="last_frame">Freeze last frame</option>
              <option value="black">Black</option>
            </select>
          </div>
          {lossBehavior === 'slate' && (
            <div className="field"><label>Slate image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {slateRef && <img src={thumbUrl(slateRef, 92, 68)} alt="" style={{ width: 46, height: 34, objectFit: 'cover', borderRadius: 6, background: '#000', flex: 'none' }} />}
                <input className="inp" value={slateRef} onChange={e => setSlateRef(e.target.value)} placeholder="Pick from library, upload, or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse / upload…</button>
              </div>
              <div className="hintxt">Browse the Image Library or upload a new slate right here.</div>
            </div>
          )}
          {lossBehavior === 'vod_loop' && (
            <div className="field"><label>Loop video</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="inp" value={slateRef} onChange={e => setSlateRef(e.target.value)} placeholder="Pick an existing loop asset or paste a URL" />
                <button type="button" className="btn ghost" onClick={() => setLoopPickerOpen(true)}>Browse…</button>
              </div>
              <div className="hintxt">Uploading video loops arrives with Broadcast videos; pick an existing asset for now.</div>
            </div>
          )}
          <ImagePicker open={pickerOpen} kinds={['slate', 'brand', 'other']} title="Choose or upload a slate image"
            uploadKind="slate" uploadFolder="slates"
            onClose={() => setPickerOpen(false)} onPick={(url) => { setSlateRef(url); setPickerOpen(false) }} />
          <ImagePicker open={loopPickerOpen} kinds={['loop', 'clip', 'vod', 'other']} title="Choose a loop video"
            allowUpload={false} uploadHint="Uploading video loops arrives with Broadcast videos"
            onClose={() => setLoopPickerOpen(false)} onPick={(url) => { setSlateRef(url); setLoopPickerOpen(false) }} />

          <div style={SEC}>Delivery</div>
          <div className="field"><label>Purchasing mode</label>
            <select className="inp" value={purchasing} onChange={e => setPurchasing(e.target.value)}>
              <option value="reserved">Reserved</option>
              <option value="spot_fallback">Spot with on-demand fallback</option>
              <option value="on_demand">On demand</option>
            </select>
          </div>
          <div className="field"><label>Recording retention <span style={{ color: 'var(--faint)' }}>— blank number = keep forever</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="inp" style={{ width: 110 }} inputMode="numeric" placeholder="keep forever"
                value={retNum} onChange={e => setRetNum(e.target.value.replace(/[^0-9]/g, ''))} />
              <select className="inp" value={retUnit} onChange={e => setRetUnit(e.target.value as RetUnit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
              </select>
            </div>
            {retNum && Number(retNum) * RET_UNIT_SEC[retUnit] < dvrMin * 60 && (
              <div className="hintxt" style={{ color: 'var(--warn)' }}>Will be raised to the DVR window ({dvrMin}m) — retention can’t be shorter than DVR.</div>
            )}
          </div>
          <div className="field">
            <label>DVR catch-up window — {dvrMin} min{dvrMin >= 60 ? ` (${(dvrMin / 60).toFixed(dvrMin % 60 ? 1 : 0)}h)` : ''}</label>
            <input type="range" min={1} max={DVR_MAX_MIN} step={1} value={dvrMin} onChange={e => setDvrMin(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--brand)' }} />
            <div className="hintxt">Max 4h for 24×7 channels; event streams scrub back to the event start.</div>
          </div>

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : radio ? 'Create station' : 'Create channel'}</button>
        </div>
      </div>
    </div>
  )
}

function Preset({ sel, onClick, title, desc, meta }: { sel: boolean; onClick: () => void; title: string; desc: string; meta: string }) {
  return (
    <div className={`preset ${sel ? 'sel' : ''}`} onClick={onClick}>
      <div className="pt">{title}</div>
      <div className="px">{desc}</div>
      <div className="px" style={{ fontFamily: 'ui-monospace,monospace', marginTop: 8, color: 'var(--faint)' }}>{meta}</div>
    </div>
  )
}
