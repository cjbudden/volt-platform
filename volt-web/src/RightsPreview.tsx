// RIGHTS PREVIEW: what the EDGE gives one viewer (EDGE_RIGHTS_VARIANTS.md,
// "Testing it from the admin side"). Pick a country, a rights class and a
// time (now, or any time in the guide); the answer is the edge's own decision
// (normal, replaced with which variant, blocked), the rule behind it, a way
// to play exactly that variant, and a 24 hour strip per audience so a window
// that is wrong shows up before it airs. GET /channels|events/:id/rights-preview.
// "View as a viewer elsewhere" on the output player is the play gate's side
// of the same question; this is the CDN's.
import { useEffect, useRef, useState } from 'react'
import { api, type RightsPreviewResult } from './api'

type Kind = 'channel' | 'event'
const DECISION: Record<RightsPreviewResult['decision'], { label: string; cls: string }> = {
  allow: { label: 'Normal', cls: 'live' },
  replace: { label: 'Replaced', cls: 'warn' },
  block: { label: 'Blocked', cls: 'down' },
}

/* small icons that sit beside their text */
const IcGlobe = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
const IcPlay = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>
const IcStop = () => <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>

const pad = (n: number) => String(n).padStart(2, '0')
/** an ISO time as the value of a datetime-local input, in this browser's time zone */
const toLocalInput = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** What the API says the loop would be built from when it is not ready (rightsPreview.ts loopSource).
 *  Typed here rather than in api.ts so this fix stands on its own. */
type LoopSource = { kind: 'image' | 'video' | null; reason: string | null; build: string | null; error: string | null }

/**
 * Why a replaced viewer would get an error, and what to do about it. It used to
 * say "Set a loop" even when a slate was set, where there is nothing to set:
 * the loop is built from the slate (build queue 1.14-G5a).
 */
function loopMessage(res: RightsPreviewResult): string {
  const src = (res as RightsPreviewResult & { loopSource?: LoopSource | null }).loopSource ?? null
  const harm = 'so for now this viewer would get an error instead of the replacement.'
  if (src?.kind) {
    const from = src.kind === 'image' ? "this stream's slate image" : "this stream's loop video"
    if (src.build === 'failed') return `The loop is built from ${from}, and its last build failed${src.error ? ` (${src.error})` : ''}, ${harm} Check the slate or loop in the stream's filler settings.`
    return `The loop is built from ${from} and is not ready yet, ${harm} Nothing needs setting: it is ready once it has been built, at the latest when the stream next runs.`
  }
  if (src?.reason?.startsWith('loss behaviour')) return `When its sources drop, this stream shows neither a slate nor a loop, so it has no loop to replace with, ${harm} Choose a slate image or loop video for source loss in the stream's filler settings.`
  if (src?.reason === 'input failover is off') return `This stream has input failover off, so it has no loop to replace with, ${harm} Turn on failover and set a slate image or loop video in the stream's filler settings.`
  return `This stream has no slate image or loop video to build the loop from, ${harm} Set one in the stream's filler settings.`
}

export function RightsPreview({ kind, id }: { kind: Kind; id: string }) {
  const [country, setCountry] = useState('')
  const [rc, setRc] = useState('')
  const [at, setAt] = useState('')            // '' = now, else a datetime-local value
  const [res, setRes] = useState<RightsPreviewResult | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)

  const ask = async (cc = country, cls = rc, t = at) => {
    setErr(''); setPlaying(false)
    if (!/^[A-Za-z]{2}$/.test(cc)) { setRes(null); if (cc) setErr('Enter a two-letter country code, or XX for a country the CDN cannot tell'); return }
    setBusy(true)
    try { setRes(await api.rightsPreview(kind, id, { country: cc.toUpperCase(), rightsClass: cls || undefined, at: t ? new Date(t).toISOString() : undefined })) }
    catch (e: any) { setRes(null); setErr(e?.message || 'Could not check') }
    finally { setBusy(false) }
  }
  // the countries the rules name: the ones worth testing (no country asked yet)
  const [suggest, setSuggest] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  useEffect(() => {
    let live = true
    api.rightsPreview(kind, id, { country: 'XX' }).then(r => {
      if (!live) return
      setSuggest([...new Set(r.strip.rows.map(x => x.country).filter(Boolean))])
      setClasses([...new Set(r.strip.rows.map(x => x.rightsClass).filter(Boolean))])
    }).catch(() => { /* the form still works without suggestions */ })
    return () => { live = false }
  }, [kind, id])

  const d = res ? DECISION[res.decision] : null
  const prog = res?.rule.programme
  return (
    <div className="card rp-card">
      <div className="sec-label"><IcGlobe /> Rights preview</div>
      <div className="rp-hint">What the CDN gives a viewer with this country, rights class and time, and why. Play it to watch exactly that version.</div>
      <form className="rp-form" onSubmit={e => { e.preventDefault(); ask() }}>
        <div className="field rp-f-cc"><label htmlFor={`rp-cc-${id}`}>Country</label>
          <input id={`rp-cc-${id}`} className="inp" value={country} maxLength={2} placeholder="AU" list={`rp-ccs-${id}`}
            onChange={e => setCountry(e.target.value.toUpperCase())} aria-describedby={`rp-cc-h-${id}`} />
          <datalist id={`rp-ccs-${id}`}>{[...suggest, 'XX'].map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="field rp-f-rc"><label htmlFor={`rp-rc-${id}`}>Rights class</label>
          <input id={`rp-rc-${id}`} className="inp" value={rc} maxLength={16} placeholder="default" list={`rp-rcs-${id}`}
            onChange={e => setRc(e.target.value.toLowerCase())} />
          <datalist id={`rp-rcs-${id}`}>{classes.map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="field rp-f-at"><label htmlFor={`rp-at-${id}`}>Time</label>
          <div className="rp-at">
            <input id={`rp-at-${id}`} type="datetime-local" className="inp" value={at} onChange={e => setAt(e.target.value)} />
            {at && <button type="button" className="btn ghost" onClick={() => { setAt(''); ask(country, rc, '') }}>Now</button>}
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={busy || !country}>{busy ? 'Checking…' : 'Check'}</button>
      </form>
      {suggest.length > 0 && (
        <div className="chip-group rp-quick" id={`rp-cc-h-${id}`}>
          <span className="chip-group-l">Countries with rules</span>
          {suggest.map(c => <button key={c} type="button" className={`chip${country === c ? ' active' : ''}`} onClick={() => { setCountry(c); ask(c) }}>{c}</button>)}
        </div>
      )}
      {res && res.windows.length > 0 && (
        <div className="chip-group rp-quick">
          <span className="chip-group-l">Guide times</span>
          {res.windows.map((w, i) => (
            <button key={i} type="button" className="chip" title={`${w.title ?? 'Programme'}: ${w.mode} ${w.countries.join(', ')}`}
              onClick={() => { const t = toLocalInput(new Date(Math.max(Date.parse(w.from), Date.now()) + 60_000).toISOString()); setAt(t); ask(country, rc, t) }}>
              {w.title ?? 'Programme'} · {when(w.from)}
            </button>
          ))}
        </div>
      )}
      {err && <div className="rp-err" role="alert">{err}</div>}
      {res && d && (
        <div className="rp-result" data-decision={res.decision}>
          <div className="rp-head">
            <span className={`tag ${d.cls}`}>{d.label}</span>
            <span className="rp-who">{res.country === 'XX' ? 'Unknown country' : res.country}{res.rightsClass ? ` · ${res.rightsClass}` : ''} · {res.atIsNow ? 'now' : when(res.at)}</span>
            {res.variant && <span className="rp-key" title="The variant this audience is sent to (a cache name, the same on every edge)">variant <code>{res.variant}</code></span>}
          </div>
          <div className="rp-why">{res.rule.reason}{res.until ? ` Until ${when(res.until)}.` : ''}</div>
          {prog && (
            <div className="rp-facts">
              <span>Programme <b>{prog.title ?? 'untitled'}</b></span>
              <span>{hm(prog.startsAt)} to {hm(prog.endsAt)}</span>
              <span>{prog.mode === 'allow' ? 'Only' : 'Not in'} <b>{prog.countries.join(', ')}</b></span>
              {prog.exemptRightsClasses.length > 0 && <span>Exempt <b>{prog.exemptRightsClasses.join(', ')}</b></span>}
              {prog.replacement && <span>Replacement <b>{prog.replacement.title ?? prog.replacement.ref ?? prog.replacement.kind}</b> (plays the stream's own loop)</span>}
            </div>
          )}
          {res.decision === 'replace' && res.loopReady === false && <div className="rp-err" data-loop-missing="">{loopMessage(res)}</div>}
          {res.decision === 'replace' && !res.variantService && <div className="rp-err">The variant service is off for this deployment, so the edge blocks this viewer instead of replacing ({res.edge}).</div>}
          {res.play && (
            <div className="rp-play">
              {!playing
                ? <button className="btn" onClick={() => setPlaying(true)}><IcPlay /> Play as this viewer</button>
                : <button className="btn ghost" onClick={() => setPlaying(false)}><IcStop /> Stop</button>}
              {playing && <RpPlayer src={res.play.hls} />}
            </div>
          )}
          <Strip res={res} onPick={(cc, cls, t) => { setCountry(cc || 'XX'); setRc(cls); const v = toLocalInput(t); setAt(v); ask(cc || 'XX', cls, v) }} />
        </div>
      )}
    </div>
  )
}

/** 24 hours per audience, from the time asked about. */
function Strip({ res, onPick }: { res: RightsPreviewResult; onPick: (cc: string, rc: string, iso: string) => void }) {
  const a = Date.parse(res.strip.from), b = Date.parse(res.strip.to)
  const x = (t: number) => `${((t - a) / (b - a)) * 100}%`
  const ticks: number[] = []
  for (let h = 0; h <= 24; h += 6) ticks.push(a + h * 3600_000)
  return (
    <div className="rp-strip" aria-label="Next 24 hours per audience">
      <div className="rp-row rp-ruler"><div /><div className="rp-track rp-ticks">{ticks.map(t => <span key={t} style={{ left: x(t) }}>{hm(new Date(t).toISOString())}</span>)}</div></div>
      {res.strip.rows.map(r => (
        <div key={r.audience} className={`rp-row${r.asked ? ' asked' : ''}`}>
          <div className="rp-aud" title={r.label}>{r.label}</div>
          <div className="rp-track">
            {r.segments.filter(s => s.decision !== 'allow').map((s, i) => {
              const f = Date.parse(s.from), t = Date.parse(s.to)
              return <button key={i} type="button" className={`rp-seg ${s.decision}`} style={{ left: x(f), width: `max(3px, ${((t - f) / (b - a)) * 100}%)` }}
                title={`${s.decision === 'replace' ? 'Replaced' : 'Blocked'} ${when(s.from)} to ${when(s.to)}${s.variant ? ` (variant ${s.variant})` : ''}`}
                aria-label={`${r.label}: ${s.decision === 'replace' ? 'replaced' : 'blocked'} from ${when(s.from)} to ${when(s.to)}`}
                onClick={() => onPick(r.country, r.rightsClass, new Date(Math.max(f, Date.now()) + 60_000).toISOString())} />
            })}
          </div>
        </div>
      ))}
      <div className="rp-legend"><span><i className="rp-sw replace" /> Replaced</span><span><i className="rp-sw block" /> Blocked</span><span><i className="rp-sw allow" /> Normal</span>{res.strip.truncated && <span>Only the first 40 audiences are shown</span>}</div>
    </div>
  )
}

/** Plays the variant through its admin-only address (hls.js where MSE exists). */
function RpPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let hls: any = null, gone = false
    ;(async () => {
      const Hls = (await import('hls.js')).default
      if (gone) return
      if (Hls.isSupported()) { hls = new Hls({ liveSyncDurationCount: 3 }); hls.loadSource(src); hls.attachMedia(v) }
      else v.src = src
      v.play().catch(() => { /* muted autoplay may still be refused; the controls are there */ })
    })()
    return () => { gone = true; try { hls?.destroy() } catch { /* already gone */ } }
  }, [src])
  return <video ref={ref} className="rp-video" muted controls playsInline data-src={src} />
}
