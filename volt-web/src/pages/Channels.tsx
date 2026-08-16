import { useEffect, useMemo, useState } from 'react'
import { api, thumbUrl, type Group } from '../api'
import { subscribeLive } from '../liveStatus'
import { useProtocols, protoOf, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'

type Props = { createOpen: boolean; setCreateOpen: (v: boolean) => void; onOpen?: (id: string) => void }

type RetUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
const RET_UNIT_SEC: Record<RetUnit, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }
function splitDuration(sec: number | null): { n: string; unit: RetUnit } {
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

export default function Channels({ createOpen, setCreateOpen, onOpen }: Props) {
  const [channels, setChannels] = useState<any[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [filter, setFilter] = useState<'all' | 'transcode' | 'package_only'>('all')

  async function load() {
    const [chs, gs] = await Promise.all([api.channels(), api.groups()])
    const gmap = new Map(gs.map(g => [g.id, g]))
    setChannels(chs.map(c => ({ ...c, _g: gmap.get(c.group_id) })))
    setGroups(gs)
  }
  useEffect(() => { load() }, [])
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
          <h1>Channels</h1>
          <p>24×7 live channels. Transcode builds the rendition ladder for you; packaging takes a pre-encoded ladder.</p>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
          New channel
        </button>
      </div>

      {channels === null ? (
        <div className="loading">Loading channels…</div>
      ) : channels.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Transcode" n={counts.transcode} on={filter === 'transcode'} onClick={() => setFilter('transcode')} />
            <FChip label="Packaging" n={counts.package_only} on={filter === 'package_only'} onClick={() => setFilter('package_only')} />
          </div>
          <ChannelTable channels={shown || []} onChanged={load} onOpen={onOpen} />
        </>
      )}

      {createOpen && (
        <CreateChannel groups={groups} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load() }} />
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

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty">
      <div className="ic">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="m17 2-5 5-5-5" /></svg>
      </div>
      <h3>No channels yet</h3>
      <p>Create your first channel to start a live stream. You can make a transcode channel — we build the ABR ladder — or a packaging channel, where you send a pre-encoded ladder and we package it.</p>
      <button className="btn primary" onClick={onCreate} style={{ margin: '0 auto' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
        Create your first channel
      </button>
    </div>
  )
}

const THUMB_BG = ['linear-gradient(135deg,#7dd3fc,#3f7bff)', 'linear-gradient(135deg,#4ade80,#16a34a)', 'linear-gradient(135deg,#c4b5fd,#7c3aed)', 'linear-gradient(135deg,#fca5a5,#ef4444)', 'linear-gradient(135deg,#fdba74,#f97316)']
function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
}

function ChannelTable({ channels, onChanged, onOpen }: { channels: any[]; onChanged: () => void; onOpen?: (id: string) => void }) {
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
            <th>Channel</th>
            <th>Type</th>
            <th>Renditions</th>
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
                    <div className="thumb" style={{ background: THUMB_BG[i % THUMB_BG.length] }}>{initials(c.name)}</div>
                    <div>
                      <div className="nm">{c.name}</div>
                      <div className="id">{c._g?.name || '—'}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`tag type ${wt === 'transcode' ? 'chan' : 'event'}`}>
                    {wt === 'transcode' ? 'Transcode' : wt === 'package_only' ? 'Packaging' : '—'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {wt === 'transcode'
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

function CreateChannel({ groups, onClose, onCreated }: { groups: Group[]; onClose: () => void; onCreated: () => void }) {
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

  // filler on total loss (both flows)
  const [lossBehavior, setLossBehavior] = useState<'none' | 'slate' | 'vod_loop' | 'last_frame' | 'black'>('slate')
  const [slateRef, setSlateRef] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loopPickerOpen, setLoopPickerOpen] = useState(false)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const group = byType[type]

  function setRow(i: number, patch: Partial<PkgRow>) { setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r)) }
  function addRow() { setRows(rs => [...rs, { label: '', bitrateKbps: 1000, protocol: 'hls', url: '', backupUrl: '' }]) }
  function delRow(i: number) { setRows(rs => rs.filter((_, j) => j !== i)) }
  const heightFromLabel = (l: string) => parseInt(l, 10) || 0

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the channel a name'); return }
    if (!group) { setErr(`No ${type === 'transcode' ? 'transcode' : 'packaging'} group set up yet`); return }

    const sources: NonNullable<Parameters<typeof api.createChannel>[0]['sources']> = []
    let outputLadder: { height: number; bitrateKbps: number }[] = []
    let fallbackTranscode = false

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
      })
      onCreated()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">New channel</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Channel name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. RTM News 24" />
          </div>

          <div className="field"><label>Type</label>
            <div className="presets">
              <Preset sel={type === 'transcode'} onClick={() => setType('transcode')} title="Transcode"
                desc="One source in. We build the ABR ladder with FFmpeg." meta="1 input → many outputs" />
              <Preset sel={type === 'package_only'} onClick={() => setType('package_only')} title="Packaging"
                desc="You send a pre-encoded ladder; we just package it." meta="N inputs → N outputs" />
            </div>
          </div>

          {type === 'transcode' ? (
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
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create channel'}</button>
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
