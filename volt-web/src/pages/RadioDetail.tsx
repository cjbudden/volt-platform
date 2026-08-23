import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type RadioStationDetail, type RadioNowPlaying, type RadioLog, type RadioClass, type Group } from '../api'
import { thumbUrl } from '../api'
import AudioVisualizer from '../AudioVisualizer'
import { StatusTag, SEC, initials, THUMB_BG } from '../scaffold'
import { RadioDrawer, ClassChip } from './Radio'

/* ============================================================================
   Radio station detail — the audio-only counterpart of the channel detail
   page. The 16:9 video surface is replaced by a live AUDIO VISUALISER (level +
   spectrum from the actual output), so "are we receiving something" is visible
   even when muted. Around it: station artwork + live ICY metadata, the MP3 /
   HLS / DASH output URLs, and the timed now-playing log (song / ad / content)
   with search — the raw material for trimming and clipping.
   ========================================================================== */

const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const isImg = (u?: string | null) => !!u && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u)

export default function RadioDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [st, setSt] = useState<RadioStationDetail | null>(null)
  const [np, setNp] = useState<RadioNowPlaying | null>(null)
  const [log, setLog] = useState<RadioLog | null>(null)
  const [q, setQ] = useState('')
  const [cls, setCls] = useState<RadioClass | 'all'>('all')
  const [groups, setGroups] = useState<Group[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [vol, setVol] = useState(0.9)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null)

  async function load() {
    try { setSt(await api.radioStation(id)) } catch (e: any) { setErr(e.message) }
  }
  async function loadLog() {
    try { setLog(await api.radioLog(id, { q: q.trim() || undefined, class: cls === 'all' ? undefined : cls })) }
    catch { /* log is best-effort */ }
  }
  useEffect(() => { load(); api.groups().then(setGroups).catch(() => {}) /* eslint-disable-next-line */ }, [id])
  useEffect(() => {
    const t = setInterval(() => { api.radioNowPlaying(id).then(setNp).catch(() => {}) }, 5000)
    api.radioNowPlaying(id).then(setNp).catch(() => {})
    return () => clearInterval(t)
  }, [id])
  useEffect(() => {
    loadLog()
    const t = setInterval(loadLog, 12_000)
    return () => clearInterval(t)
    /* eslint-disable-next-line */
  }, [id, q, cls])

  const live = st?.status === 'live'
  const title = np?.title ?? st?.nowPlaying ?? null
  const titleClass = np?.class ?? st?.nowPlayingClass ?? null

  // ---- playback: MP3 fan-out when enabled (native, same-origin), else HLS ----
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    setMediaEl(a)
    let hls: any = null
    let cancelled = false
    async function attach() {
      if (!st || !live || !playing || !a) return
      if (st.outputs.mp3) { a.src = st.outputs.mp3; a.play().catch(() => {}); return }
      if (st.outputs.hls) {
        if (a.canPlayType('application/vnd.apple.mpegurl')) { a.src = st.outputs.hls; a.play().catch(() => {}); return }
        const Hls = (await import('hls.js')).default
        if (cancelled) return
        if (Hls.isSupported()) {
          hls = new Hls({ liveDurationInfinity: true })
          hls.loadSource(st.outputs.hls!)
          hls.attachMedia(a)
          hls.on(Hls.Events.MANIFEST_PARSED, () => a.play().catch(() => {}))
        }
      }
    }
    if (playing && live) attach()
    else { a.pause(); a.removeAttribute('src'); a.load() }
    return () => { cancelled = true; if (hls) hls.destroy() }
    /* eslint-disable-next-line */
  }, [playing, live, st?.outputs.mp3, st?.outputs.hls])
  useEffect(() => { const a = audioRef.current; if (a) { a.muted = muted; a.volume = vol } }, [muted, vol])
  useEffect(() => { if (!live) setPlaying(false) }, [live])

  async function startStop(action: 'start' | 'stop') {
    setBusy(true); setErr('')
    try { await api.radioStartStop(id, action); await load(); if (action === 'stop') setPlaying(false) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const art = st?.brand_ref ? thumbUrl(st.brand_ref, 320, 320, 'cover')
    : isImg(np?.streamUrl) ? np!.streamUrl! : null

  const counts = log?.counts ?? {}
  const total = (counts.song ?? 0) + (counts.ad ?? 0) + (counts.content ?? 0)

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(new URL(text, window.location.origin).toString()) } catch { /* */ }
  }

  if (!st) return <div className="loading">{err || 'Loading station…'}</div>

  return (
    <>
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn ghost" onClick={onBack} style={{ padding: '6px 10px' }}>←</button>
          {art
            ? <div style={{ width: 52, height: 52, borderRadius: 12, overflow: 'hidden', background: '#0b0f16', flex: 'none' }}><img src={art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>
            : <div className="thumb" style={{ width: 52, height: 52, borderRadius: 12, background: THUMB_BG[0], fontSize: 18 }}>{initials(st.name)}</div>}
          <div>
            <h1 style={{ margin: 0 }}>{st.name}</h1>
            <p style={{ margin: '3px 0 0' }}>{st.group_name} · {st.sources[0]?.protocol?.toUpperCase() || 'no source'} in · {st.radio_config?.bitrateKbps ?? 128}k out{st.pipeline.running && st.pipeline.sourceCodec ? ` · source ${st.pipeline.sourceCodec}` : ''}</p>
          </div>
        </div>
        <div className="spacer" />
        {live ? <StatusTag label="On air" cls="live" /> : <StatusTag label="Off" cls="idle" />}
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>Settings</button>
        {live
          ? <button className="btn ghost" disabled={busy} onClick={() => startStop('stop')}>{busy ? '…' : 'Stop station'}</button>
          : <button className="btn primary" disabled={busy} onClick={() => startStop('start')}>{busy ? '…' : 'Start station'}</button>}
      </div>
      {err && <div className="err">{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(280px,1fr)', gap: 16, alignItems: 'start' }}>
        {/* ---- player: visualiser instead of a 16:9 video ---- */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <button className="btn primary" disabled={!live} onClick={() => setPlaying(p => !p)}>
              {playing ? 'Stop listening' : 'Listen'}
            </button>
            <div className="icon-btn" title={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(m => !m)}>
              {muted
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6" /></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>}
            </div>
            <input type="range" min={0} max={1} step={0.02} value={vol} onChange={e => setVol(Number(e.target.value))} style={{ width: 120 }} />
            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--faint)' }}>
              {live ? (st.pipeline.running ? `${np?.listeners ?? st.pipeline.listeners ?? 0} MP3 listeners` : '') : 'Start the station to monitor the output'}
            </div>
          </div>
          <AudioVisualizer media={mediaEl} height={230}
            idleText={live ? (playing ? 'Waiting for audio…' : 'Press Listen to monitor the output') : 'Station is off'} />
          <audio ref={audioRef} crossOrigin="anonymous" style={{ display: 'none' }} />
          {/* now playing strip under the visualiser */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, minHeight: 30 }}>
            {isImg(np?.streamUrl) && <img src={np!.streamUrl!} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover' }} />}
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {live ? (title || 'Untitled break') : 'Off air'}
            </div>
            <ClassChip cls={live ? titleClass : null} />
            {live && np?.since && <span style={{ fontSize: 12, color: 'var(--faint)' }}>{fmtDur(Date.now() - np.since)} in</span>}
          </div>
        </div>

        {/* ---- station metadata + outputs ---- */}
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <div style={SEC}>Station metadata</div>
            {st.icy?.station?.name || np?.station?.name ? (
              <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                <MetaRow k="Station" v={np?.station?.name || st.icy?.station?.name} />
                <MetaRow k="Genre" v={np?.station?.genre || st.icy?.station?.genre} />
                <MetaRow k="Website" v={np?.station?.url || st.icy?.station?.url} />
                <MetaRow k="Source bitrate" v={(np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps) ? `${np?.station?.bitrateKbps || st.icy?.station?.bitrateKbps} kbps` : undefined} />
                <MetaRow k="Content type" v={np?.station?.contentType || st.icy?.station?.contentType} />
                <MetaRow k="Title changes" v={st.icy ? String(st.icy.changes) : undefined} />
              </div>
            ) : <div style={{ fontSize: 12.5, color: 'var(--faint)' }}>ICY headers appear here when the station runs against an Icecast source.</div>}
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={SEC}>Outputs</div>
            {([['MP3', st.outputs.mp3], ['HLS', st.outputs.hls], ['DASH', st.outputs.dash]] as const).map(([label, url]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ width: 44, fontSize: 11, fontWeight: 700, color: url ? 'var(--brand)' : 'var(--faint)' }}>{label}</span>
                <span style={{ flex: 1, fontFamily: 'ui-monospace,monospace', fontSize: 11.5, color: url ? 'var(--muted)' : 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {url || 'disabled'}
                </span>
                {url && <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => copy(url)}>Copy</button>}
              </div>
            ))}
            {st.openRecording && (
              <div style={{ marginTop: 10, fontSize: 12.5 }}>
                Recording since {new Date(Number(st.openRecording.start_epoch_ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                <a href={`/recordings/${st.openRecording.id}`} style={{ color: 'var(--brand)' }}
                  onClick={e => { e.preventDefault(); window.history.pushState({}, '', `/recordings/${st.openRecording!.id}`); window.dispatchEvent(new PopStateEvent('popstate')) }}>
                  open in the clipping workbench
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- timed metadata log ---- */}
      <div className="card" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ ...SEC, margin: 0 }}>Received metadata log</div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
            {(['all', 'song', 'ad', 'content'] as const).map(c => (
              <div key={c} className={`chip ${cls === c ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setCls(c)}>
                {c === 'all' ? `All ${total}` : `${CLASS_LABEL[c]} ${counts[c] ?? 0}`}
              </div>
            ))}
          </div>
          <input className="inp" style={{ width: 260, marginLeft: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search titles (what was played when)…" />
        </div>
        {!log || log.entries.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--faint)', padding: '14px 4px' }}>
            {q.trim() ? 'No entries match.' : 'Entries appear while the station runs against an Icecast source with the metadata log enabled: every now-playing change is captured with its time, classified as song, ad or content, and becomes searchable here and in Recordings.'}
          </div>
        ) : (
          <table>
            <thead><tr><th style={{ width: 170 }}>When</th><th style={{ width: 90 }}>Length</th><th>Title</th><th style={{ width: 90 }}>Class</th></tr></thead>
            <tbody>
              {log.entries.map((e) => {
                const liveRow = e.status === 'live'
                const dur = new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()
                return (
                  <tr key={e.id} style={liveRow ? { background: 'rgba(63,123,255,.07)' } : undefined}>
                    <td style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtClock(e.starts_at)} → {liveRow ? 'now' : fmtClock(e.ends_at)}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>{liveRow ? '…' : fmtDur(dur)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isImg(e.stream_url) && <img src={e.stream_url!} alt="" style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }} />}
                        <span>{e.title || <span style={{ color: 'var(--faint)' }}>Untitled break</span>}</span>
                        {liveRow && <span className="tag live" style={{ fontSize: 9 }}>on air</span>}
                      </div>
                    </td>
                    <td><ClassChip cls={e.class} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {settingsOpen && (
        <RadioDrawer groups={groups} station={st} onClose={() => setSettingsOpen(false)}
          onDone={() => { setSettingsOpen(false); load() }} />
      )}
    </>
  )
}

const CLASS_LABEL: Record<string, string> = { song: 'Songs', ad: 'Ads', content: 'Content' }

function MetaRow({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 110, color: 'var(--faint)' }}>{k}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
    </div>
  )
}
