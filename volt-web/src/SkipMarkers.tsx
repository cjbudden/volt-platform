import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { api, type VodMarkerKind, type VodMarkersView } from './api'
import VoltPlayerView from './VoltPlayerView'
import { useNotify } from './notices'

/* ==========================================================================
   SKIP MARKERS: intro, recap and credits on an on-demand asset.

   Found automatically against the other episodes of the series, or set here,
   and changeable at any time: the asset's playlists are annotated when they
   are served, so a change reaches viewers on their next playlist fetch.

   The player is the admin player on the asset's HLS playlist, the same file a
   viewer gets, so its Skip button is the real thing. After a change the
   playlist is reloaded where you were, to show the result.

   Times here are positions in the asset (m:ss.s), not clock times.
   ========================================================================== */

const KINDS: { kind: VodMarkerKind; label: string; hint: string; color: string }[] = [
  { kind: 'intro', label: 'Intro', hint: 'Titles and theme. Viewers get "Skip intro".', color: 'var(--brand)' },
  { kind: 'recap', label: 'Recap', hint: '"Previously on". Viewers get "Skip recap".', color: '#a78bfa' },
  { kind: 'credits', label: 'Credits', hint: 'End credits. Viewers get "Skip credits", or the next item in a playlist.', color: 'var(--warn,#e2b64f)' },
]

export function fmtPos(ms: number): string {
  const t = Math.max(0, ms) / 1000
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const ss = s.toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
/** "1:23.5", "83.5", "1:02:03" → ms, or null. */
export function parsePos(v: string): number | null {
  const parts = v.trim().split(':').map((x) => x.trim())
  if (!parts.length || parts.some((x) => x === '' || isNaN(Number(x)))) return null
  let sec = 0
  for (const x of parts) sec = sec * 60 + Number(x)
  return Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : null
}
const fmtLen = (ms: number) => { const s = ms / 1000; return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` }

type Drag = { kind: VodMarkerKind; edge: 'start' | 'end' | 'move'; x0: number; s0: number; e0: number; w: number }

export default function SkipMarkers({ asset }: { asset: { id: string; master_key?: string | null; duration_ms?: number | string | null; title?: string | null } }) {
  const notify = useNotify()
  const [v, setV] = useState<VodMarkersView | null>(null)
  const [draft, setDraft] = useState<Partial<Record<VodMarkerKind, { startMs: number; endMs: number }>>>({})
  const [busy, setBusy] = useState('')
  const [ver, setVer] = useState(0)
  const [pos, setPos] = useState(0)
  const media = useRef<HTMLVideoElement | null>(null)
  const resumeAt = useRef<number | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const load = useCallback(async () => {
    try { setV(await api.vodMarkers(asset.id)) } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }, [asset.id, notify])
  useEffect(() => { load() }, [load])
  // While detection runs, look again every few seconds.
  useEffect(() => {
    if (!v?.detection.running) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [v?.detection.running, load])

  // The playhead, for the timeline and "set to playhead". Also restores the
  // position after a playlist reload.
  useEffect(() => {
    let raf = 0
    const tick = () => { const m = media.current; if (m) setPos(m.currentTime * 1000); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  useEffect(() => {
    const m = media.current
    if (!m) return
    const on = () => { if (resumeAt.current != null) { m.currentTime = resumeAt.current; resumeAt.current = null } }
    m.addEventListener('loadedmetadata', on)
    return () => m.removeEventListener('loadedmetadata', on)
  }, [ver])

  const durMs = v?.durationMs || Number(asset.duration_ms) || 0
  const byKind = (k: VodMarkerKind) => v?.markers.find((m) => m.kind === k) ?? null
  const shown = (k: VodMarkerKind): { startMs: number; endMs: number } | null => draft[k] ?? byKind(k)

  const reloadPlayer = () => { resumeAt.current = media.current ? media.current.currentTime : null; setVer((n) => n + 1) }

  async function save(k: VodMarkerKind, startMs: number, endMs: number) {
    setBusy(k)
    try {
      await api.setVodMarker(asset.id, k, Math.round(startMs), Math.round(endMs))
      await load(); reloadPlayer()
      notify({ kind: 'ok', message: 'Marker saved.' })
    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally {
      setBusy(''); setDraft((d) => { const n = { ...d }; delete n[k]; return n })
    }
  }
  async function run(label: string, fn: () => Promise<any>, reload = true) {
    setBusy(label)
    try { await fn(); await load(); if (reload) reloadPlayer() } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }
  const seek = (ms: number, play = false) => { const m = media.current; if (!m) return; m.currentTime = Math.max(0, ms / 1000); if (play) m.play().catch(() => {}) }

  // ---- timeline dragging: the edges move one end, the body moves both
  function down(e: RPointerEvent, kind: VodMarkerKind, edge: Drag['edge']) {
    const r = shown(kind); const w = track.current?.getBoundingClientRect().width ?? 0
    if (!r || !w || !durMs) return
    e.stopPropagation(); e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { kind, edge, x0: e.clientX, s0: r.startMs, e0: r.endMs, w }
  }
  function move(e: RPointerEvent) {
    const d = drag.current; if (!d) return
    const dm = ((e.clientX - d.x0) / d.w) * durMs
    let s = d.s0, en = d.e0
    if (d.edge === 'start') s = Math.min(Math.max(0, d.s0 + dm), d.e0 - 1000)
    else if (d.edge === 'end') en = Math.max(Math.min(durMs, d.e0 + dm), d.s0 + 1000)
    else { const len = d.e0 - d.s0; s = Math.min(Math.max(0, d.s0 + dm), durMs - len); en = s + len }
    setDraft((x) => ({ ...x, [d.kind]: { startMs: s, endMs: en } }))
    seek(d.edge === 'end' ? en : s)
  }
  function up() {
    const d = drag.current; drag.current = null
    if (!d) return
    const r = draft[d.kind]
    if (r && (Math.abs(r.startMs - d.s0) > 50 || Math.abs(r.endMs - d.e0) > 50)) save(d.kind, r.startMs, r.endMs)
    else setDraft((x) => { const n = { ...x }; delete n[d.kind]; return n })
  }
  const pct = (ms: number) => `${durMs ? Math.max(0, Math.min(100, (ms / durMs) * 100)) : 0}%`

  // tick labels every 1, 2, 5, 10 ... minutes so there are about eight
  const ticks: number[] = []
  if (durMs) {
    const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000)
    const step = steps.find((s) => durMs / s <= 10) ?? 3600_000
    for (let t = 0; t <= durMs; t += step) ticks.push(t)
  }

  if (!asset.master_key) return <div className="hintxt">This asset has no playlist yet, so there is nothing to mark. Markers can be set once it is built.</div>

  return (
    <div className="skm">
      <div className="skm-main">
        <VoltPlayerView src={`${asset.master_key}${asset.master_key.includes('?') ? '&' : '?'}m=${ver}`} skin="admin" title={asset.title ?? null} mediaRef={media} autoplay={false} />
        <div className="skm-tl">
          <div className="skm-track" ref={track}
            onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            onClick={(e) => { if (drag.current) return; const r = track.current!.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * durMs) }}>
            {KINDS.map(({ kind, label, color }) => {
              const r = shown(kind); if (!r) return null
              const m = byKind(kind)
              return (
                <div key={kind} className={`skm-rng${m?.status === 'suggested' && !draft[kind] ? ' sug' : ''}`}
                  style={{ left: pct(r.startMs), width: `calc(${pct(r.endMs - r.startMs)})`, ['--c' as any]: color }}
                  onPointerDown={(e) => down(e, kind, 'move')} title={`${label} ${fmtPos(r.startMs)} to ${fmtPos(r.endMs)}`}>
                  <span className="h l" onPointerDown={(e) => down(e, kind, 'start')} aria-label={`${label} start`} />
                  <span className="t">{label}</span>
                  <span className="h r" onPointerDown={(e) => down(e, kind, 'end')} aria-label={`${label} end`} />
                </div>
              )
            })}
            <div className="skm-ph" style={{ left: pct(pos) }} />
          </div>
          <div className="skm-ticks">{ticks.map((t) => <span key={t} style={{ left: pct(t) }}>{fmtPos(t).replace(/\.0$/, '')}</span>)}</div>
        </div>
        <div className="hintxt" style={{ marginTop: 6 }}>
          Drag a marker's edges or move it whole; click the bar to jump there. Changes reach viewers on their next playlist load, nothing is rebuilt.
        </div>
      </div>

      <div className="skm-side">
        <div className="skm-pos">Playhead <b>{fmtPos(pos)}</b></div>
        {KINDS.map(({ kind, label, hint, color }) => {
          const m = byKind(kind); const r = shown(kind)
          return (
            <div key={kind} className="skm-row">
              <div className="skm-row-h">
                <span className="dot" style={{ background: color }} />
                <b>{label}</b>
                {m && <span className={`skm-src ${m.status}`}>
                  {m.status === 'suggested' ? `Suggested${m.confidence != null ? ` · ${Math.round(m.confidence * 100)}%` : ''}`
                    : m.source === 'auto' ? `Found${m.detail?.comparedWith ? ` · ${m.detail.agreed}/${m.detail.comparedWith} episodes` : ''}` : 'Set by hand'}
                </span>}
              </div>
              {r ? (
                <>
                  <div className="skm-times">
                    <TimeField value={r.startMs} onCommit={(ms) => save(kind, ms, Math.max(ms + 1000, r.endMs))} label={`${label} start`} />
                    <span>to</span>
                    <TimeField value={r.endMs} onCommit={(ms) => save(kind, Math.min(r.startMs, ms - 1000), ms)} label={`${label} end`} />
                    <span className="len">{fmtLen(r.endMs - r.startMs)}</span>
                  </div>
                  <div className="skm-acts">
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => save(kind, Math.min(pos, r.endMs - 1000), r.endMs)} title="Start the marker at the playhead">Start here</button>
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => save(kind, r.startMs, Math.max(pos, r.startMs + 1000))} title="End the marker at the playhead">End here</button>
                    <button className="btn ghost sm" onClick={() => seek(Math.max(0, r.startMs - 3000), true)} title="Play from just before it, to see the Skip button">Preview</button>
                    {m?.status === 'suggested' && <button className="btn primary sm" disabled={!!busy} onClick={() => run(kind, () => api.acceptVodMarker(asset.id, kind))}>Use it</button>}
                    <button className="btn ghost sm danger" disabled={!!busy} onClick={() => run(kind, () => api.deleteVodMarker(asset.id, kind))}>Remove</button>
                  </div>
                </>
              ) : (
                <div className="skm-acts">
                  <span className="hintxt" style={{ flex: 1 }}>{hint}</span>
                  <button className="btn ghost sm" disabled={!!busy || !durMs}
                    onClick={() => { const s = Math.min(pos, Math.max(0, durMs - 30_000)); save(kind, s, Math.min(durMs, s + 30_000)) }}>Add at playhead</button>
                </div>
              )}
            </div>
          )
        })}
        <div className="skm-det">
          <div className="sec-label" style={{ margin: 0 }}>Automatic detection</div>
          <div className="hintxt">
            {v?.detection.running ? 'Comparing with the other episodes…'
              : v?.detection.note ?? 'Not run yet. It runs by itself after each build, comparing the asset with other episodes of its series.'}
          </div>
          {v?.detection.group && <div className="hintxt">Series: <code>{v.detection.group.replace(/^(series|prog|title):([^:]*:)?/, '')}</code></div>}
          <button className="btn ghost sm" disabled={!!busy || !!v?.detection.running}
            onClick={() => run('detect', () => api.detectVodMarkers(asset.id), false)}>
            {v?.detection.running ? 'Detecting…' : 'Detect now'}
          </button>
          <div className="hintxt">Detection never changes a marker set or accepted by hand.</div>
        </div>
      </div>
    </div>
  )
}

function TimeField({ value, onCommit, label }: { value: number; onCommit: (ms: number) => void; label: string }) {
  const [t, setT] = useState(fmtPos(value))
  const [bad, setBad] = useState(false)
  useEffect(() => { setT(fmtPos(value)); setBad(false) }, [value])
  const commit = () => {
    const ms = parsePos(t)
    if (ms == null) { setBad(true); return }
    if (Math.abs(ms - value) >= 50) onCommit(ms); else setT(fmtPos(value))
  }
  return (
    <input className={`skm-time${bad ? ' bad' : ''}`} value={t} aria-label={label} inputMode="decimal"
      onChange={(e) => { setT(e.target.value); setBad(false) }}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setT(fmtPos(value)); (e.target as HTMLInputElement).blur() } }} />
  )
}
