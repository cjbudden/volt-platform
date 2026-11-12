// After encoding, by hand (services/media/postProcess.ts): subtitles made from
// the asset's audio (Whisper on this server, or an add-on) and a short AI
// description when it has none. The same steps an ingest rule asks for,
// started now. Shown at the top of the Files tab, where the subtitles land.
import { useEffect, useRef, useState } from 'react'
import { apiRequest, type PostProcessOptions } from '../../api'

type StepState = 'waiting' | 'queued' | 'running' | 'done' | 'skipped' | 'failed' | 'used_up' | 'off'
interface Step { state: StepState; message?: string | null; at?: string; engine?: string; description?: string; files?: { id: string; language: string }[] }
interface View {
  postProcess: null | { plan: { subtitles: string; describe: string; by: string }; subtitles?: Step; describe?: Step }
  hasMedia: boolean
  captions: { language: string | null; source: string }[]
  description: { field: string | null; filled: boolean; contentType: boolean }
  options: PostProcessOptions
}

const WORDS: Record<StepState, string> = {
  waiting: 'Waiting for the encode', queued: 'Queued', running: 'Working', done: 'Done', skipped: 'Not needed',
  failed: 'Failed', used_up: 'Used up this month', off: 'Not on',
}
const busy = (s?: Step) => !!s && (s.state === 'queued' || s.state === 'running' || s.state === 'waiting')

export function AssetPostProcess({ id, onFilesChanged, onMetadataChanged }: { id: string; onFilesChanged: () => void; onMetadataChanged?: () => void }) {
  const [v, setV] = useState<View | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [subs, setSubs] = useState<'off' | 'whisper' | 'addon'>('off')
  const [addonId, setAddonId] = useState('')
  const [spoken, setSpoken] = useState('auto')
  const [extra, setExtra] = useState<string[]>([])
  const [model, setModel] = useState('base')
  const [describe, setDescribe] = useState(false)
  const [replace, setReplace] = useState(false)
  const [sending, setSending] = useState(false)
  const last = useRef<string>('')

  const load = () => apiRequest(`/vod/${id}/post-process`).then((r: View) => {
    setV(r); setErr('')
    // A step that just finished changed the files or the fields under it.
    const sig = `${r.postProcess?.subtitles?.state}|${r.postProcess?.describe?.state}`
    if (last.current && last.current !== sig) {
      if (r.postProcess?.subtitles?.state === 'done') onFilesChanged()
      if (r.postProcess?.describe?.state === 'done') onMetadataChanged?.()
    }
    last.current = sig
  }, (e: any) => setErr(e.message))
  useEffect(() => { setV(null); last.current = ''; load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = busy(v?.postProcess?.subtitles) || busy(v?.postProcess?.describe)
  useEffect(() => {
    if (!active) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [active, id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (v && subs === 'off' && !describe) setSubs(v.options.whisper.ready ? 'whisper' : v.options.addons.length ? 'addon' : 'off') }, [v?.options]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!v) return err ? <div className="asset-img-err">{err}</div> : null
  const o = v.options
  const pp = v.postProcess
  const start = async () => {
    setSending(true); setErr('')
    try {
      const r: View = await apiRequest(`/vod/${id}/post-process`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subtitles: subs, addonId: subs === 'addon' ? addonId || null : null, spoken, languages: extra, model, describe, replace }),
      })
      setV(r); setOpen(false)
    } catch (e: any) { setErr(e.message) } finally { setSending(false) }
  }
  const lang = (c: string) => o.languages.find((l) => l.code === c)?.label ?? c
  const canSubs = subs === 'whisper' ? o.whisper.ready : subs === 'addon' ? !!addonId : true
  const canDescribe = !describe || (o.ai.offered && o.ai.on)
  const nothing = subs === 'off' && !describe

  const stepLine = (name: string, s?: Step) => s && (
    <div className={`app-step ${s.state}`}>
      <span className="app-step-n">{name}</span>
      <span className="app-step-s">{WORDS[s.state] ?? s.state}</span>
      <span className="app-step-m">{s.message ?? ''}{s.description ? <span className="app-step-d"> “{s.description}”</span> : null}</span>
    </div>
  )

  return (
    <div className="app-pp">
      <div className="app-pp-head">
        <div>
          <div className="afiles-drop-t">Make from the audio</div>
          <div className="lib-faint">
            Subtitles made by {o.whisper.ready ? 'Whisper on this server' : 'an add-on'}, and a short AI description when it has none.
            {v.captions.length ? ` It has subtitles in ${[...new Set(v.captions.map((c) => c.language ? lang(c.language) : 'an unnamed language'))].join(', ')}.` : ''}
          </div>
        </div>
        {!open && <button className="btn" disabled={active || !v.hasMedia} title={!v.hasMedia ? 'There is no media on this server to listen to yet.' : active ? 'Already working on it.' : ''} onClick={() => setOpen(true)}>Make…</button>}
      </div>

      {pp && (pp.subtitles || pp.describe) && (
        <div className="app-steps">
          {stepLine('Subtitles', pp.subtitles)}
          {stepLine('Description', pp.describe)}
          <div className="lib-faint">Asked by {pp.plan.by}.</div>
        </div>
      )}

      {open && (
        <div className="app-form">
          <label><span>Subtitles</span>
            <select value={subs} onChange={(e) => setSubs(e.target.value as any)}>
              <option value="off">Don't make subtitles</option>
              <option value="whisper" disabled={!o.whisper.ready}>Whisper on this server{o.whisper.ready ? '' : ' (not installed)'}</option>
              <option value="addon" disabled={!o.addons.length}>An add-on{o.addons.length ? '' : ' (none switched on)'}</option>
            </select></label>
          {subs === 'addon' && <label><span>Add-on</span>
            <select value={addonId} onChange={(e) => setAddonId(e.target.value)}>
              <option value="">Choose…</option>
              {o.addons.map((a) => <option key={a.id} value={a.id}>{a.name}{a.simulated ? ' (simulated)' : ''}</option>)}
            </select></label>}
          {subs !== 'off' && <label><span>Language spoken</span>
            <select value={spoken} onChange={(e) => setSpoken(e.target.value)}>
              <option value="auto">Detect it</option>
              {o.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select></label>}
          {subs !== 'off' && <label><span>Also make (translated)</span>
            <select multiple value={extra} onChange={(e) => setExtra([...e.target.selectedOptions].map((x) => x.value))} className="app-multi">
              {o.languages.filter((l) => l.code !== spoken).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select></label>}
          {subs === 'whisper' && <label><span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {o.models.map((m) => <option key={m} value={m}>{m}{m === 'tiny' ? ' (fastest)' : m === 'large-v3' ? ' (best, slowest)' : ''}</option>)}
            </select></label>}
          <label className="app-check"><input type="checkbox" checked={describe} disabled={!o.ai.offered} onChange={(e) => setDescribe(e.target.checked)} />
            <span>Write a description with AI{!o.ai.offered ? ' (not available here)' : !o.ai.on ? ' (an add-on: turn it on in Admin, Billing)' : o.ai.allowance ? ` (${o.ai.allowance.left} left this month)` : ''}</span></label>
          {describe && v.description.filled && <label className="app-check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>Replace the description it has now</span></label>}
          <div className="app-notes lib-faint">
            {subs === 'whisper' && !o.whisper.translate && extra.some((l) => l !== 'en') && <div>Whisper translates into English by itself. Other languages need the NLLB translation model on this server; they are reported as not made.</div>}
            {describe && !v.description.contentType && <div>Choose a content type first: the description goes into its description field.</div>}
            {describe && v.description.filled && !replace && <div>It already has a description, so none will be written unless you tick Replace.</div>}
            {subs !== 'off' && v.captions.length > 0 && <div>A language it already has subtitles for is not made again.</div>}
          </div>
          <div className="app-acts">
            <button className="btn primary" disabled={sending || nothing || !canSubs || !canDescribe} onClick={start}>{sending ? 'Starting…' : 'Start'}</button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="asset-img-err">{err}</div>}
    </div>
  )
}
