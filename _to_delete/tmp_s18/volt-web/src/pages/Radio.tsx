import { useEffect, useMemo, useState } from 'react'
import { api, type RadioStationRow, type Group, type RadioCfg } from '../api'
import { useProtocols, SourceInput, type SourceValue } from '../protocols'
import { ImagePicker } from '../ImagePicker'
import { PageHead, NewButton, FChip, EntityCell, StatusPill, Preset, RecordingSection, RET_UNIT_SEC, SEC, splitDuration, type RetUnit, type PipelineState } from '../scaffold'
import { navigate } from '../router'
import { thumbUrl } from '../api'

/* ============================================================================
   Radio — audio-only stations on the shared design language (same base
   structure and feature placement as Channels and Events). List page here;
   click a station for the detail page (visualiser, now-playing, metadata log).
   See RADIO.md for the workflow decisions this form encodes.
   ========================================================================== */

export const CLASS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  song: { label: 'Song', bg: 'rgba(63,123,255,.16)', fg: '#7dabff' },
  ad: { label: 'Ad', bg: 'rgba(251,191,36,.14)', fg: '#fbbf24' },
  content: { label: 'Content', bg: 'rgba(74,222,128,.14)', fg: '#4ade80' },
}
export function ClassChip({ cls }: { cls: string | null }) {
  const c = CLASS_CHIP[cls || ''] || null
  if (!c) return null
  return <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c.bg, color: c.fg, textTransform: 'uppercase', letterSpacing: '.04em' }}>{c.label}</span>
}

/** Audio-valid source protocols only (the point of a radio form). */
export const RADIO_PROTOCOLS = ['icecast', 'hls', 'srt']

/** Signal verdict chip: is what we are receiving actually programme audio? */
const SIGNAL: Record<string, { label: string; color: string }> = {
  audio: { label: 'Audio', color: '#4ade80' },
  quiet: { label: 'Low', color: '#fbbf24' },
  silent: { label: 'Dead air', color: '#f87171' },
  static: { label: 'Static', color: '#fb923c' },
  unknown: { label: 'No data', color: '#64748b' },
}
export function SignalChip({ verdict }: { verdict?: string }) {
  const s = SIGNAL[verdict || 'unknown'] ?? SIGNAL.unknown
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
      <span style={{ color: 'var(--muted)' }}>{s.label}</span>
    </span>
  )
}

/** Roll-up state badge — delegates to the ONE platform definition so a station
 *  and a channel in the same state always look and read the same. */
export function StateTag({ state, onAir, sub }: { state?: string; onAir?: boolean; sub?: string }) {
  return <StatusPill state={(state ?? (onAir ? 'onair' : 'idle')) as PipelineState} sub={sub} />
}

export default function Radio() {
  const [rows, setRows] = useState<RadioStationRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'live' | 'off'>('all')

  async function load() {
    try { setRows(await api.radioStations()) } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => {
    load(); api.groups().then(setGroups).catch(() => {})
    const t = setInterval(load, 10_000)   // keep now-playing fresh
    return () => clearInterval(t)
  }, [])

  async function startStop(r: RadioStationRow, action: 'start' | 'stop') {
    setBusy(r.id); setErr('')
    try { await api.radioStartStop(r.id, action); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  async function setAir(r: RadioStationRow, on: boolean) {
    setBusy(r.id); setErr('')
    try { await api.radioSetAir(r.id, on); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy('') }
  }

  const counts = useMemo(() => {
    const c = rows || []
    return {
      all: c.length,
      onair: c.filter(r => r.onAir).length,
      running: c.filter(r => r.status === 'live' && !r.onAir).length,
      off: c.filter(r => r.status !== 'live').length,
    }
  }, [rows])
  const shown = useMemo(() => {
    if (!rows) return []
    if (filter === 'all') return rows
    if (filter === 'live') return rows.filter(r => r.status === 'live')
    return rows.filter(r => r.status !== 'live')
  }, [rows, filter])

  const open = (r: RadioStationRow) => navigate(`/radio/${r.id}`)

  return (
    <>
      <PageHead title="Radio" sub="Audio-only stations: MP3, HLS and DASH out, Icecast in, and a timed now-playing log for search and clipping."
        action={<NewButton label="New station" onClick={() => setCreateOpen(true)} />} />
      {err && <div className="err">{err}</div>}
      {rows === null ? (
        <div className="loading">Loading stations…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 11h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /><circle cx="8" cy="15.5" r="2.5" /><path d="M17 14h2M17 17h2M18 3 7 8" /></svg></div>
          <h3>No stations yet</h3>
          <p>Create a station from an Icecast mount (or HLS/SRT audio). Try the SomaFM samples: ice5.somafm.com/groovesalad-128-mp3, secretagent-128-mp3, dronezone-128-mp3.</p>
          <button className="btn primary" onClick={() => setCreateOpen(true)} style={{ margin: '0 auto' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
            Create your first station
          </button>
        </div>
      ) : (
        <>
          <div className="filters">
            <FChip label="All" n={counts.all} on={filter === 'all'} onClick={() => setFilter('all')} />
            <FChip label="Running" n={counts.onair + counts.running} on={filter === 'live'} onClick={() => setFilter('live')} />
            <FChip label="Off" n={counts.off} on={filter === 'off'} onClick={() => setFilter('off')} />
            <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-sm)', color: 'var(--faint)', alignSelf: 'center' }}>{counts.onair} on air</span>
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Station</th><th>Now playing</th><th>Signal</th><th>Outputs</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {shown.map((r, i) => {
                  const live = r.status === 'live'
                  const outs = [r.outputs.mp3 && 'MP3', r.outputs.hls && 'HLS', r.outputs.dash && 'DASH'].filter(Boolean).join(' · ')
                  return (
                    <tr key={r.id} onClick={() => open(r)} style={{ cursor: 'pointer' }}>
                      <td><EntityCell name={r.name} sub={r.group_name} index={i}
                        imgUrl={r.brand_ref ? thumbUrl(r.brand_ref, 80, 80, 'cover') : undefined} /></td>
                      <td style={{ maxWidth: 230 }}>
                        {live && r.nowPlaying != null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nowPlaying || 'Untitled break'}</span>
                            <ClassChip cls={r.nowPlayingClass} />
                          </div>
                        ) : <span style={{ color: 'var(--faint)' }}>—</span>}
                      </td>
                      <td>{live ? <SignalChip verdict={r.signal} /> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                      <td style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{outs} · {r.radio_config?.bitrateKbps ?? 128}k</td>
                      <td><StateTag state={r.pipelineState} onAir={r.onAir}
                        sub={live && r.pipeline.running ? `${r.pipeline.listeners ?? 0} listener${(r.pipeline.listeners ?? 0) === 1 ? '' : 's'}` : undefined} /></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        {/* two steps, like channels: run it, then publish it */}
                        {live
                          ? <>
                              {r.onAir
                                ? <button className="btn ghost" style={{ color: 'var(--warn,#fbbf24)' }} disabled={busy === r.id} onClick={() => setAir(r, false)}>{busy === r.id ? '…' : 'Off air'}</button>
                                : <button className="btn primary" disabled={busy === r.id} onClick={() => setAir(r, true)}>{busy === r.id ? '…' : 'Go on air'}</button>}
                              <button className="btn ghost" style={{ marginLeft: 6 }} disabled={busy === r.id} onClick={() => startStop(r, 'stop')}>Stop</button>
                            </>
                          : <button className="btn primary" disabled={busy === r.id} onClick={() => startStop(r, 'start')}>{busy === r.id ? '…' : 'Start'}</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {createOpen && <RadioDrawer groups={groups} onClose={() => setCreateOpen(false)} onDone={(id) => { setCreateOpen(false); id ? navigate(`/radio/${id}`) : load() }} />}
    </>
  )
}

/* --------------------------------------------- create / settings drawer.
   Same section order as channels/events: Name → Type → Source → Outputs →
   Metadata log → Recording → Transcription. Exported for the detail page. */
export function RadioDrawer({ groups, station, onClose, onDone }: {
  groups: Group[]
  station?: {
    id: string; name: string; version: number; brand_ref?: string | null
    radio_config: RadioCfg | null; recording_enabled?: boolean
    recording_retention_sec?: number | string | null
    sources?: { role: string; protocol: string; ingest_url: string | null; stream_key?: string | null }[]
    status?: string
  }
  onClose: () => void
  onDone: (createdId?: string) => void
}) {
  const isEdit = !!station
  const protocols = useProtocols()
  const radioProtocols = useMemo(
    () => protocols.filter(p => RADIO_PROTOCOLS.includes(p.id)),
    [protocols])
  const cfg = station?.radio_config ?? {}
  const [name, setName] = useState(station?.name ?? '')
  // Packaging is the default; transcode exists to change bitrate or format.
  const [transcode, setTranscode] = useState(cfg.transcode === true)
  const src0 = station?.sources?.find(s => s.role === 'primary')
  const [primary, setPrimary] = useState<SourceValue>({
    protocol: (src0?.protocol || 'icecast').toLowerCase(),
    url: src0?.ingest_url || '', streamKey: src0?.stream_key || undefined,
  })
  const [outMp3, setOutMp3] = useState(cfg.outputs?.mp3 !== false)
  const [outHls, setOutHls] = useState(cfg.outputs?.hls !== false)
  const [outDash, setOutDash] = useState(cfg.outputs?.dash !== false)
  const [bitrate, setBitrate] = useState(cfg.bitrateKbps ?? 128)
  const [metaCapture, setMetaCapture] = useState(cfg.metadataCapture !== false)
  const [transcription, setTranscription] = useState(cfg.transcription === true)
  const [artRef, setArtRef] = useState(station?.brand_ref || '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [recOn, setRecOn] = useState(station ? station.recording_enabled !== false : true)
  const initRet = splitDuration(station?.recording_retention_sec != null ? Number(station.recording_retention_sec) : null)
  const [retNum, setRetNum] = useState(isEdit ? initRet.n : '')
  const [retUnit, setRetUnit] = useState<RetUnit>(initRet.unit)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const isIcecast = primary.protocol === 'icecast'
  const groupId = groups.find(g => g.workflow_type === 'package_only')?.id ?? groups[0]?.id ?? ''

  async function submit() {
    setErr('')
    if (!name.trim()) { setErr('Give the station a name'); return }
    if (!isEdit && !primary.url.trim()) { setErr('Add the source stream URL'); return }
    if (!isEdit && !groupId) { setErr('No group set up yet'); return }
    if (!outMp3 && !outHls && !outDash) { setErr('Enable at least one output'); return }
    const radio: RadioCfg = {
      outputs: { mp3: outMp3, hls: outHls, dash: outDash },
      bitrateKbps: bitrate,
      metadataCapture: isIcecast ? metaCapture : false,
      transcode,
      transcription: isIcecast ? transcription : false,
    }
    const retention = recOn && retNum ? Number(retNum) * RET_UNIT_SEC[retUnit] : null
    const sources = primary.url.trim()
      ? [{ role: 'primary' as const, protocol: primary.protocol, ingestUrl: primary.url.trim(), streamKey: primary.streamKey?.trim() || undefined }]
      : []
    setBusy(true)
    try {
      if (isEdit) {
        await api.updateChannel(station!.id, {
          name: name.trim(), radio, recordingEnabled: recOn, recordingRetentionSec: retention,
          ...(sources.length ? { sources } : {}), brandRef: artRef.trim() || null,
          version: station!.version,
        } as any)
        onDone()
      } else {
        const ch = await api.createChannel({
          groupId, name: name.trim(), kind: 'radio', radio,
          recordingEnabled: recOn, recordingRetentionSec: retention,
          sources, brandRef: artRef.trim() || null,
        })
        onDone(ch.id)
      }
    } catch (e: any) {
      if (/version|match|409/i.test(String(e.message))) setErr('This station changed since you opened it. Reopen and retry.')
      else setErr(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h"><div className="t">{isEdit ? 'Station settings' : 'New station'}</div><button className="xbtn" onClick={onClose}>✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Station name</label>
            <input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Groove Salad" />
          </div>
          <div className="field"><label>Station artwork <span style={{ color: 'var(--faint)' }}>— shown on the detail page and player</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="inp" value={artRef} onChange={e => setArtRef(e.target.value)} placeholder="Pick from library or paste a URL" />
              <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}>Browse…</button>
            </div>
          </div>
          <ImagePicker open={pickerOpen} kinds={['brand', 'other']} title="Choose or upload station artwork"
            uploadKind="brand" uploadFolder="brand" allowUpload
            onClose={() => setPickerOpen(false)} onPick={(url) => { setArtRef(url); setPickerOpen(false) }} />

          <div className="field"><label>Type</label>
            <div className="presets">
              <Preset sel={!transcode} onClick={() => setTranscode(false)} title="Packaging"
                desc="Repackage the source audio as-is. The default for radio." meta="copy where possible" />
              <Preset sel={transcode} onClick={() => setTranscode(true)} title="Transcode"
                desc="Only needed to change the bitrate or format of the source." meta="re-encode at the bitrate below" />
            </div>
          </div>

          <div style={SEC}>Source</div>
          <SourceInput protocols={radioProtocols} value={primary} onChange={setPrimary} label="Audio source" />
          {isIcecast && <div className="hintxt">Icecast mounts carry now-playing (ICY) metadata: enable the log below to capture it.</div>}

          <div style={SEC}>Outputs — single bitrate</div>
          <div className="toggle-row"><div><div className="tt">MP3 stream</div><div className="td">Universal HTTP audio (hardware receivers, old apps, VLC). Now-playing titles pass through.</div></div>
            <div className={`sw ${outMp3 ? '' : 'off'}`} onClick={() => setOutMp3(v => !v)}><i /></div></div>
          <div className="toggle-row"><div><div className="tt">HLS (audio-only)</div><div className="td">Apple and modern web players; also what recording and clipping use.</div></div>
            <div className={`sw ${outHls ? '' : 'off'}`} onClick={() => setOutHls(v => !v)}><i /></div></div>
          <div className="toggle-row"><div><div className="tt">DASH</div><div className="td">Android and TV stacks.</div></div>
            <div className={`sw ${outDash ? '' : 'off'}`} onClick={() => setOutDash(v => !v)}><i /></div></div>
          <div className="field"><label>Output bitrate</label>
            <select className="inp" value={bitrate} onChange={e => setBitrate(Number(e.target.value))}>
              {[64, 96, 128, 192, 256, 320].map(b => <option key={b} value={b}>{b} kbps</option>)}
            </select>
            <div className="hintxt">Radio is single bitrate by design: no ladder to manage. Packaging keeps the source bitrate for MP3 when the source is already MP3.</div>
          </div>

          {isIcecast && (
            <>
              <div style={SEC}>Metadata log</div>
              <div className="toggle-row">
                <div><div className="tt">Capture now-playing log</div><div className="td">Every ICY title change becomes a timed entry (stored on the programme guide), classified as song, ad or content. Drives search, trimming and clipping.</div></div>
                <div className={`sw ${metaCapture ? '' : 'off'}`} onClick={() => setMetaCapture(v => !v)}><i /></div>
              </div>
            </>
          )}

          <RecordingSection ctx="channel" recOn={recOn} setRecOn={setRecOn}
            retNum={retNum} setRetNum={setRetNum} retUnit={retUnit} setRetUnit={setRetUnit} />

          {isIcecast && (
            <>
              <div style={SEC}>Transcription</div>
              <div className="toggle-row">
                <div><div className="tt">Transcribe speech segments</div><div className="td">Uses the metadata log to transcribe only the parts classified as content (DJ talk, news, interviews). Songs and adverts are skipped. Only offered for Icecast sources, where metadata can tell speech from music.</div></div>
                <div className={`sw ${transcription ? '' : 'off'}`} onClick={() => setTranscription(v => !v)}><i /></div>
              </div>
            </>
          )}
          {!isIcecast && <div className="hintxt" style={{ marginTop: 10 }}>Transcription is available for Icecast sources only: without now-playing metadata there is no way to tell speech from songs and adverts, and transcripts of music are noise.</div>}

          {err && <div className="err">{err}</div>}
        </div>
        <div className="drawer-f">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create station'}</button>
        </div>
      </div>
    </div>
  )
}
