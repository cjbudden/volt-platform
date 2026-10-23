// ============================================================================
//  FORMATS TAB (Media Library > asset > Formats; volt/REFRAME.md).
//
//  The 16:9 picture with the crop for 9:16, 1:1 or 4:5 drawn over it, the
//  faces Volt is following, a timeline of shots, subjects and crop keyframes,
//  live previews of every format, and the controls a person needs to correct
//  it: drag the crop to set a keyframe, choose who a shot follows, change how
//  a keyframe moves, approve, render.
//
//  WHAT YOU SEE IS WHAT IS ENCODED: the preview samples the path with the same
//  easing the render uses (reframeApi.sampleAt mirrors framing.ts sampleAt),
//  so nothing is rendered until the operator asks.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getToken } from '../../api'
import { Notice, useNotify } from '../../notices'
import { reframeApi, sampleAt, timecode, type FormatKey, type FormatView, type Key, type ReframeView, type TrackStore } from './reframeApi'
import './formats.css'

const FMTS: FormatKey[] = ['9x16', '1x1', '4x5']
const RATIO: Record<FormatKey, number> = { '9x16': 9 / 16, '1x1': 1, '4x5': 4 / 5 }
const LABEL: Record<FormatKey, string> = { '9x16': '9:16', '1x1': '1:1', '4x5': '4:5' }

function useAttach(ref: { current: HTMLVideoElement | null }, file: string | null, hls: string | null, onError: (m: string) => void) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let engine: any, cancelled = false
    if (file) { el.src = file; return () => { el.removeAttribute('src'); el.load() } }
    if (!hls) return
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (cancelled) return
      if (Hls.isSupported()) {
        engine = new Hls({ xhrSetup: (xhr: XMLHttpRequest, u: string) => {
          try { if (new URL(u, window.location.href).pathname.startsWith('/api/')) { xhr.open('GET', u, true); xhr.setRequestHeader('authorization', `Bearer ${getToken()}`) } } catch { /* */ }
        } })
        engine.loadSource(hls); engine.attachMedia(el)
      } else if (el.canPlayType('application/vnd.apple.mpegurl')) el.src = hls
      else onError('HLS is not supported in this browser')
    })()
    return () => { cancelled = true; try { engine?.destroy() } catch { /* */ }; el.removeAttribute('src'); el.load() }
    /* eslint-disable-next-line */
  }, [file, hls])
}

/** The box of each subject on screen at t (nearest sample within 0.4 s). */
function boxesAt(store: TrackStore | null, t: number) {
  if (!store) return []
  const out: { subject: string; x: number; y: number; w: number; h: number }[] = []
  for (const tr of store.tracks) {
    if (t < tr.start - 0.4 || t > tr.end + 0.4) continue
    let lo = 0, hi = tr.samples.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (tr.samples[m][0] < t) lo = m + 1; else hi = m }
    const cand = [tr.samples[lo], tr.samples[lo - 1]].filter(Boolean)
    const s = cand.sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0]
    if (s && Math.abs(s[0] - t) <= 0.4) out.push({ subject: tr.subject, x: s[1], y: s[2], w: s[3], h: s[4] })
  }
  return out
}

function Preview({ video, keys, fmt, tick, active, onPick, label }: {
  video: HTMLVideoElement | null; keys: Key[]; fmt: FormatKey; tick: number; active: boolean; onPick: () => void; label: string
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const H = 136, W = Math.round(H * RATIO[fmt])
  useEffect(() => {
    const c = ref.current, v = video
    if (!c || !v || v.readyState < 2 || !v.videoWidth) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const vw = v.videoWidth, vh = v.videoHeight
    const s = sampleAt(keys, v.currentTime)
    try {
      if (s.mode === 'fill') {
        const cover = Math.max(W / vw, H / vh)
        ctx.filter = 'blur(6px) brightness(0.8)'
        ctx.drawImage(v, (W - vw * cover) / 2, (H - vh * cover) / 2, vw * cover, vh * cover)
        ctx.filter = 'none'
        const fit = W / vw
        ctx.drawImage(v, 0, (H - vh * fit) / 2, W, vh * fit)
      } else {
        const sw = s.w * vw, sh = s.h * vh
        ctx.drawImage(v, Math.max(0, Math.min(vw - sw, s.cx * vw - sw / 2)), Math.max(0, Math.min(vh - sh, s.cy * vh - sh / 2)), sw, sh, 0, 0, W, H)
      }
    } catch { /* a frame not ready yet */ }
  }, [video, keys, fmt, tick, W])
  return (
    <button type="button" className={`rf-prev${active ? ' on' : ''}`} onClick={onPick} aria-pressed={active} aria-label={`Edit the ${label} framing`}>
      <canvas ref={ref} width={W} height={H} style={{ width: W, height: H }} />
      <span className="mono">{label}</span>
    </button>
  )
}

function ReviewPill({ f }: { f: FormatView }) {
  if (!f.path) return <span className="tag idle">Not framed</span>
  if (f.review === 'approved') return <span className="tag live" title={f.approvedBy ? `Approved by ${f.approvedBy}` : undefined}>Approved</span>
  const n = f.path.needsReview.length
  return n ? <span className="tag warn">Check {n === 1 ? `shot ${f.path.needsReview[0] + 1}` : `${n} shots`}</span> : <span className="tag sched">To approve</span>
}

function RenderState({ f }: { f: FormatView }) {
  const r = f.render
  if (r.progress) return <span className="rf-rs">{r.progress.state === 'queued' ? 'Queued' : `Rendering ${Math.round(r.progress.pct)}%`}</span>
  if (r.state === 'ready' && r.key) return <a className="rf-rs" href={r.key} download>{`Download${r.bytes ? ` · ${(r.bytes / 1048576).toFixed(1)} MB` : ''}`}</a>
  if (r.state === 'stale') return <span className="rf-rs warn" title="The framing changed after this file was rendered">Out of date</span>
  if (r.state === 'failed') return <span className="rf-rs bad" title={r.error ?? undefined}>Render failed</span>
  return <span className="rf-rs faint">Not rendered</span>
}

export default function FormatsPanel({ asset }: { asset: { id: string; title?: string | null } }) {
  const id = asset.id
  const [view, setView] = useState<ReframeView | null>(null)
  const [store, setStore] = useState<TrackStore | null>(null)
  const [err, setErr] = useState('')
  const [playErr, setPlayErr] = useState('')
  const [fmt, setFmt] = useState<FormatKey>('9x16')
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selKey, setSelKey] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ cx: number; cy: number } | null>(null)
  const [busy, setBusy] = useState('')
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number; w: number; h: number; id: number } | null>(null)
  const notify = useNotify()

  const load = useCallback(async () => {
    try { setView(await reframeApi.view(id)); setErr('') } catch (e: any) { setErr(e.message) }
  }, [id])
  useEffect(() => { load() }, [load])
  const analysedAt = view?.analysis.analysedAt
  useEffect(() => {
    if (view?.analysis.state !== 'ready') return
    reframeApi.tracks(id).then(setStore).catch(() => setStore(null))
    /* eslint-disable-next-line */
  }, [id, analysedAt])
  // poll while something runs
  const running = !!view && (!!view.analysis.progress || view.formats.some((f) => f.render.progress))
  useEffect(() => {
    if (!running) return
    const h = setInterval(load, 1500)
    return () => clearInterval(h)
  }, [running, load])

  useAttach(videoRef, view?.media.file ?? null, view?.media.hls ?? null, setPlayErr)
  // the playhead: every frame while playing, on seek otherwise
  useEffect(() => {
    const v = videoEl
    if (!v) return
    let raf = 0
    const loop = () => { setT(v.currentTime); if (!v.paused) raf = requestAnimationFrame(loop) }
    const on = () => { setPlaying(!v.paused); cancelAnimationFrame(raf); loop() }
    const evs = ['play', 'pause', 'seeked', 'loadeddata', 'timeupdate']
    evs.forEach((e) => v.addEventListener(e, on))
    return () => { cancelAnimationFrame(raf); evs.forEach((e) => v.removeEventListener(e, on)) }
  }, [videoEl])

  const fv = view?.formats.find((f) => f.format === fmt) ?? null
  const keys = fv?.path?.keys ?? []
  const shots = store?.shots ?? view?.analysis.summary?.shots ?? []
  const D = store?.source.durationSec || view?.analysis.summary?.source.durationSec || (view?.durationMs ?? 0) / 1000 || 1
  const fps = store?.source.fps || 25
  const shotNow = shots.find((s) => t >= s.start && t < s.end) ?? shots[shots.length - 1]
  const plan = fv?.path?.shots.find((s) => s.index === shotNow?.index)
  const subj = useMemo(() => Object.fromEntries((store?.subjects ?? view?.analysis.summary?.subjects ?? []).map((s) => [s.id, s])), [store, view])
  const crop = drag ? { ...sampleAt(keys, t), ...drag, mode: 'crop' as const } : sampleAt(keys, t)
  const boxes = boxesAt(store, t)
  const followed = new Set(plan?.follow === 'group'
    ? (store?.tracks.filter((x) => x.shot === shotNow?.index).map((x) => x.subject) ?? [])
    : [plan?.follow])

  const seek = (s: number) => { const v = videoRef.current; if (v) { v.currentTime = Math.max(0, Math.min(D, s)); setT(v.currentTime) } }
  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label)
    try { await fn(); await load() } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy('') }
  }

  async function saveKeys(next: Key[]) {
    if (!fv?.path) return
    setView((v) => v && ({ ...v, formats: v.formats.map((f) => f.format === fmt && f.path ? { ...f, path: { ...f.path, keys: next } } : f) }))
    await act('save', () => reframeApi.saveKeys(id, fmt, next))
  }
  function upsertKey(at: number, cx: number, cy: number) {
    const k = [...keys]
    const i = k.findIndex((x) => Math.abs(x.t - at) < 0.12)
    if (i >= 0) { k[i] = { ...k[i], cx, cy, mode: 'crop' }; return { keys: k, t: k[i].t } }
    const shot = shotNow?.index ?? 0
    const at3 = Math.round(at * 1000) / 1000
    const prevI = k.reduce((acc, x, j) => (x.t < at3 ? j : acc), -1)
    const next = k.find((x) => x.t > at3)
    if (prevI >= 0 && k[prevI].shot === shot && k[prevI].ease === 'hold') k[prevI] = { ...k[prevI], ease: 'glide' }
    const nk: Key = { t: at3, cx, cy, w: crop.w, h: crop.h, ease: next && next.shot === shot ? 'glide' : 'hold', mode: 'crop', shot }
    k.push(nk); k.sort((a, b) => a.t - b.t)
    return { keys: k, t: at3 }
  }

  function onCropDown(e: React.PointerEvent) {
    if (!stageRef.current || crop.mode === 'fill' || !fv?.path) return
    const r = stageRef.current.getBoundingClientRect()
    dragRef.current = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy, w: r.width, h: r.height, id: e.pointerId }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    videoRef.current?.pause()
  }
  function onCropMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const cx = Math.max(crop.w / 2, Math.min(1 - crop.w / 2, d.cx + (e.clientX - d.x) / d.w))
    const cy = Math.max(crop.h / 2, Math.min(1 - crop.h / 2, d.cy + (e.clientY - d.y) / d.h))
    setDrag({ cx, cy })
  }
  async function onCropUp() {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !drag) { setDrag(null); return }
    const { keys: next, t: kt } = upsertKey(t, Math.round(drag.cx * 10000) / 10000, Math.round(drag.cy * 10000) / 10000)
    setDrag(null)
    setSelKey(kt)
    await saveKeys(next)
  }
  function onStageKey(e: React.KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !fv?.path || crop.mode === 'fill') return
    e.preventDefault()
    const step = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowLeft' ? -1 : 1)
    const cx = Math.max(crop.w / 2, Math.min(1 - crop.w / 2, crop.cx + step))
    const { keys: next, t: kt } = upsertKey(t, Math.round(cx * 10000) / 10000, crop.cy)
    setSelKey(kt); saveKeys(next)
  }

  if (err && !view) return <Notice kind="error" variant="compact" title="Couldn't load the formats." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />
  if (!view) return <div className="loading">Loading…</div>
  if (view.audioOnly) return <Notice kind="info" variant="compact" title="Sound only" message="This asset has no picture, so there is nothing to frame for social formats." />

  const a = view.analysis
  if (a.state !== 'ready' || !a.summary) {
    return (
      <div className="card rf-empty">
        <div className="card-b">
          <h3>Social formats</h3>
          <p>Volt follows the faces in this {view.title ? `clip` : 'asset'} and frames a 9:16, 1:1 and 4:5 version of it. Analysis looks at the picture once, at a fraction of its running time, and nothing is rendered until you ask.</p>
          {a.progress ? (
            <div className="rf-progress" role="status">
              <div className="bar"><span style={{ width: `${a.progress.pct}%` }} /></div>
              <span>{a.progress.state === 'queued' ? 'Waiting to start…' : `${a.progress.note || 'Analysing'} · ${Math.round(a.progress.pct)}%`}</span>
            </div>
          ) : (
            <>
              {a.state === 'failed' && <Notice kind="error" variant="compact" title="The analysis failed." message={a.error ?? 'No reason was given.'} />}
              <button className="btn primary" disabled={!!busy} onClick={() => act('analyse', () => reframeApi.analyse(id))}>
                {a.state === 'failed' ? 'Try again' : 'Analyse the picture'}
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const sm = a.summary
  const engine = sm.analysis?.engine ?? {}
  const pct = (x: number) => `${(x / D) * 100}%`
  const renderable = view.formats.filter((f) => f.path)
  const fillSpans = keys.map((k, i) => k.mode === 'fill' ? [k.t, keys[i + 1]?.t ?? D] : null).filter(Boolean) as number[][]
  const selected = keys.find((k) => selKey != null && Math.abs(k.t - selKey) < 1e-3) ?? null
  const shotSubjects = [...new Set((store?.tracks ?? []).filter((x) => x.shot === shotNow?.index).map((x) => x.subject))]

  return (
    <div className="rf">
      <div className="rf-bar">
        <span className="rf-sum">{sm.shots.length} shot{sm.shots.length === 1 ? '' : 's'} · {sm.subjects.length} subject{sm.subjects.length === 1 ? '' : 's'} · analysed in {sm.analysis?.seconds ?? '?'} s</span>
        {engine.note && <span className="tag warn" title={engine.note}>Faces not detected on this server</span>}
        <div className="flex-1" />
        <button className="btn ghost" disabled={!!busy || !!a.progress} onClick={() => act('analyse', () => reframeApi.analyse(id))}>{a.progress ? 'Analysing…' : 'Re-analyse'}</button>
        <button className="btn primary" disabled={!!busy || !renderable.length} onClick={() => act('render', () => reframeApi.render(id))}>
          Render {renderable.length} format{renderable.length === 1 ? '' : 's'}
        </button>
      </div>

      <div className="rf-grid">
        <div className="rf-main">
          <section className="card">
            <div className="card-h">
              <h3>Source {sm.source.width}×{sm.source.height}</h3>
              <span className="sub">Showing the crop for</span>
              <div className="rf-seg" role="group" aria-label="Format">
                {FMTS.map((f) => <button key={f} type="button" className={f === fmt ? 'on' : ''} aria-pressed={f === fmt} onClick={() => { setFmt(f); setSelKey(null) }}>{LABEL[f]}</button>)}
              </div>
            </div>
            <div className="card-b">
              <div className="rf-stage" ref={stageRef} style={{ aspectRatio: `${sm.source.width} / ${sm.source.height}` }}
                tabIndex={0} onKeyDown={onStageKey} aria-label="Picture. Drag the crop, or use the left and right arrow keys, to set a keyframe at the playhead.">
                <video ref={(el) => { videoRef.current = el; setVideoEl(el) }} muted playsInline preload="auto" crossOrigin="anonymous" />
                {crop.mode === 'fill' ? (
                  <div className="rf-fill"><span>Whole picture on a blurred fill</span></div>
                ) : (
                  <>
                    <div className="rf-mask" style={{ left: 0, top: 0, bottom: 0, width: `${(crop.cx - crop.w / 2) * 100}%` }} />
                    <div className="rf-mask" style={{ right: 0, top: 0, bottom: 0, width: `${(1 - crop.cx - crop.w / 2) * 100}%` }} />
                    {crop.h < 1 && <>
                      <div className="rf-mask" style={{ left: `${(crop.cx - crop.w / 2) * 100}%`, width: `${crop.w * 100}%`, top: 0, height: `${(crop.cy - crop.h / 2) * 100}%` }} />
                      <div className="rf-mask" style={{ left: `${(crop.cx - crop.w / 2) * 100}%`, width: `${crop.w * 100}%`, bottom: 0, height: `${(1 - crop.cy - crop.h / 2) * 100}%` }} />
                    </>}
                    <div className={`rf-crop${drag ? ' drag' : ''}`} onPointerDown={onCropDown} onPointerMove={onCropMove} onPointerUp={onCropUp} onPointerCancel={() => { dragRef.current = null; setDrag(null) }}
                      style={{ left: `${(crop.cx - crop.w / 2) * 100}%`, top: `${(crop.cy - crop.h / 2) * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}>
                      <span className="mono">{LABEL[fmt]}</span>
                    </div>
                  </>
                )}
                {boxes.map((b, i) => (
                  <div key={i} className={`rf-box${followed.has(b.subject) ? ' on' : ''}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
                    <span>{subj[b.subject]?.label ?? b.subject}</span>
                  </div>
                ))}
              </div>
              {playErr && <div className="rf-err">{playErr}</div>}
              <div className="rf-transport">
                <button className="btn ghost icon" aria-label="Previous frame" onClick={() => seek(t - 1 / fps)}>‹</button>
                <button className="btn ghost icon" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { const v = videoRef.current; if (v) { if (v.paused) v.play(); else v.pause() } }}>{playing ? '❚❚' : '▶'}</button>
                <button className="btn ghost icon" aria-label="Next frame" onClick={() => seek(t + 1 / fps)}>›</button>
                <span className="mono tc">{timecode(t, fps)}</span><span className="mono faint">/ {timecode(D, fps)}</span>
                {shotNow && <span className="faint">Shot {shotNow.index + 1} of {shots.length}{plan ? ` · ${plan.mode === 'fill' ? 'whole picture' : `follows ${plan.followLabel}`}` : ''}</span>}
              </div>
            </div>
          </section>

          <section className="card" aria-label="Timeline">
            <div className="card-h"><h3>Timeline</h3><span className="sub">Drag the crop in the picture to set a keyframe at the playhead. Click a keyframe to select it.</span></div>
            <div className="card-b rf-tl">
              <div className="rf-lane ruler"><span />
                <div className="trk" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * D) }}>
                  {Array.from({ length: 7 }, (_, i) => <span key={i} className="mono" style={{ left: `${(i / 6) * 100}%` }}>{timecode((i / 6) * D, fps).slice(3, 8)}</span>)}
                </div>
              </div>
              <div className="rf-lane"><span className="name">Shots</span>
                <div className="trk">
                  {shots.map((s) => (
                    <button key={s.index} type="button" className={`blk shot${fv?.path?.needsReview.includes(s.index) ? ' warn' : ''}${s.index === shotNow?.index ? ' cur' : ''}`}
                      style={{ left: pct(s.start), width: `calc(${pct(s.end - s.start)} - 2px)` }} onClick={() => seek(s.start + 0.001)}
                      title={fv?.path?.shots.find((p) => p.index === s.index)?.reason}>{s.index + 1}</button>
                  ))}
                </div>
              </div>
              {sm.subjects.map((s) => (
                <div key={s.id} className="rf-lane"><span className="name">{s.label}</span>
                  <div className="trk">
                    {(store?.tracks ?? []).filter((x) => x.subject === s.id).map((x) => (
                      <span key={x.id} className="blk subj" style={{ left: pct(x.start), width: pct(Math.max(0.2, x.end - x.start)) }} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="rf-lane"><span className="name">Crop path · {LABEL[fmt]}</span>
                <div className="trk">
                  <span className="path" />
                  {fillSpans.map(([s0, s1], i) => <span key={i} className="blk fill" style={{ left: pct(s0), width: pct(s1 - s0) }}>blurred fill</span>)}
                  {keys.map((k) => (
                    <button key={k.t} type="button" className={`key ${k.cut ? 'cut' : k.ease}${selKey != null && Math.abs(k.t - selKey) < 1e-3 ? ' sel' : ''}`}
                      style={{ left: pct(k.t) }} aria-label={`Keyframe at ${timecode(k.t, fps)}`} onClick={() => { setSelKey(k.t); seek(k.t + 0.001) }} />
                  ))}
                </div>
              </div>
              <div className="rf-playhead" style={{ left: `calc(132px + (100% - 132px) * ${Math.min(1, t / D)})` }} />
            </div>
          </section>
        </div>

        <aside className="rf-side">
          <section className="card">
            <div className="card-h"><h3>Outputs</h3><span className="spacer" /><span className="sub">Follow the playhead</span></div>
            <div className="card-b">
              <div className="rf-prevs">
                {view.formats.map((f) => (
                  <Preview key={f.format} video={videoEl} keys={f.path?.keys ?? []} fmt={f.format} tick={t} active={f.format === fmt}
                    onPick={() => { setFmt(f.format); setSelKey(null) }} label={LABEL[f.format]} />
                ))}
              </div>
              {view.formats.map((f) => (
                <div key={f.format} className="rf-out">
                  <span className="nm">{LABEL[f.format]} <span className="mono faint">{f.width}×{f.height}</span>{f.edited && <span className="faint"> · edited</span>}</span>
                  <ReviewPill f={f} />
                  <RenderState f={f} />
                </div>
              ))}
            </div>
          </section>

          {fv?.path && shotNow && plan && (
            <section className="card">
              <div className="card-h"><h3>Shot {shotNow.index + 1}</h3><span className="sub mono">{timecode(shotNow.start, fps)}–{timecode(shotNow.end, fps)}</span></div>
              <div className="card-b rf-insp">
                <label className="rf-field">
                  <span className="lbl">Follow</span>
                  <select value={fv.overrides[String(shotNow.index)]?.follow ?? ''} disabled={!!busy}
                    onChange={(e) => act('follow', () => reframeApi.follow(id, fmt, shotNow.index, e.target.value || null))}>
                    <option value="">Volt decides{plan.chosenBy === 'auto' ? ` (${plan.mode === 'fill' ? 'whole picture' : plan.followLabel})` : ''}</option>
                    {shotSubjects.map((s) => <option key={s} value={s}>{subj[s]?.label ?? s}</option>)}
                    {shotSubjects.length > 1 && <option value="group">Everyone together</option>}
                    <option value="centre">Centre of the picture</option>
                    <option value="fill">Whole picture on a blurred fill</option>
                  </select>
                </label>
                <p className={`rf-why${plan.confidence < 0.75 ? ' warn' : ''}`}>{plan.reason} <span className="mono">confidence {plan.confidence.toFixed(2)}</span></p>

                {selected ? (
                  <div className="rf-key">
                    <span className="lbl">Keyframe at {timecode(selected.t, fps)}</span>
                    <div className="rf-seg" role="group" aria-label="Into the next keyframe">
                      {(['glide', 'linear', 'hold'] as const).map((e) => (
                        <button key={e} type="button" className={selected.ease === e ? 'on' : ''} aria-pressed={selected.ease === e}
                          onClick={() => saveKeys(keys.map((k) => k === selected ? { ...k, ease: e } : k))}>{e === 'glide' ? 'Glide' : e === 'linear' ? 'Linear' : 'Hold'}</button>
                      ))}
                    </div>
                    {selected.w < 1 && (
                      <label className="rf-field"><span className="lbl">Position across the picture</span>
                        <input type="range" min={selected.w / 2} max={1 - selected.w / 2} step={0.001} value={selected.cx}
                          onChange={(e) => setView((v) => v && ({ ...v, formats: v.formats.map((f) => f.format === fmt && f.path ? { ...f, path: { ...f.path, keys: f.path.keys.map((k) => k.t === selected.t ? { ...k, cx: Number(e.target.value) } : k) } } : f) }))}
                          onPointerUp={() => saveKeys(keys)} onKeyUp={() => saveKeys(keys)} />
                      </label>
                    )}
                    <button className="btn ghost" disabled={!!busy || keys.length < 2} onClick={() => { setSelKey(null); saveKeys(keys.filter((k) => k !== selected)) }}>Delete keyframe</button>
                  </div>
                ) : (
                  <button className="btn ghost" disabled={!!busy || crop.mode === 'fill'} onClick={() => { const r = upsertKey(t, crop.cx, crop.cy); setSelKey(r.t); saveKeys(r.keys) }}>Add a keyframe at the playhead</button>
                )}
              </div>
            </section>
          )}

          {fv?.path && (
            <section className="card">
              <div className="card-h"><h3>{LABEL[fmt]} framing</h3><span className="spacer" /><ReviewPill f={fv} /></div>
              <div className="card-b rf-actions">
                {fv.review !== 'approved' && <button className="btn primary" disabled={!!busy} onClick={() => act('approve', () => reframeApi.approve(id, fmt))}>Approve {LABEL[fmt]}</button>}
                <button className="btn ghost" disabled={!!busy} onClick={() => act('render1', () => reframeApi.render(id, [fmt]))}>Render {LABEL[fmt]}</button>
                {(fv.edited || Object.keys(fv.overrides).length > 0) && (
                  <button className="btn ghost" disabled={!!busy} onClick={() => act('reset', () => reframeApi.reset(id, fmt))}>Back to Volt's framing</button>
                )}
                {fv.approvedBy && fv.review === 'approved' && <p className="faint">Approved by {fv.approvedBy}{fv.approvedAt ? `, ${new Date(fv.approvedAt).toLocaleString()}` : ''}</p>}
                {fv.render.state === 'failed' && fv.render.error && <p className="rf-err">{fv.render.error}</p>}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
