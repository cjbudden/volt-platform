// ============================================================================
//  FORMATS AND REFRAMING (Admin > Formats and reframing; volt/REFRAME.md).
//
//  Which social formats Volt makes from 16:9 media, what it keeps in frame,
//  how the framing may move, when it runs, and which format each social
//  platform receives. Operators correct any one asset in its Formats tab.
//  Saves through /api/account-settings/reframe (volt-app modules/reframe.ts).
// ============================================================================
import { useEffect, useState } from 'react'
import { PageHead } from '../scaffold'
import { Notice, useNotify, FormStatus } from '../notices'
import { reframeApi, type ReframeSettings, type ReframeSettingsView, type TargetFormat } from './vod/reframeApi'
import './vod/formats.css'

const SHAPE: Record<string, { w: number; h: number }> = { '9x16': { w: 18, h: 32 }, '1x1': { w: 28, h: 28 }, '4x5': { w: 25, h: 31 }, '16x9': { w: 32, h: 18 } }
const FOLLOW_LABEL: Record<string, string> = { faces: 'Faces: the person on screen longest, then any face', people: 'People (bodies), when no face is found', centre: 'The centre of the picture' }
const TARGET_LABEL: Record<TargetFormat, string> = { '16x9': '16:9 source', '9x16': '9:16 vertical', '1x1': '1:1 square', '4x5': '4:5 portrait' }

function Shape({ k }: { k: string }) {
  const s = SHAPE[k]
  return <span className="rfs-shape" aria-hidden="true"><span style={{ width: s.w, height: s.h }} /></span>
}

function Toggle({ checked, onChange, disabled, children, hint }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <label className="rfs-row rfs-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span>{children}</span>{hint && <span className="rfs-hint">{hint}</span>}</span>
    </label>
  )
}

export default function ReframeSettingsPage() {
  const [v, setV] = useState<ReframeSettingsView | null>(null)
  const [s, setS] = useState<ReframeSettings | null>(null)
  const [err, setErr] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  const load = async () => { try { const x = await reframeApi.settings(); setV(x); setS(x.settings); setErr('') } catch (e: any) { setErr(e.message) } }
  useEffect(() => { load() }, [])
  if (err && !v) return <Notice kind="error" title="Couldn't load the settings." message={err} actions={[{ label: 'Retry', onClick: () => { load() } }]} />
  if (!v || !s) return <div className="loading">Loading…</div>

  const ro = !v.canEdit
  const dirty = JSON.stringify(s) !== JSON.stringify(v.settings)
  const set = (p: Partial<ReframeSettings>) => setS({ ...s, ...p })
  const move = (i: number, d: -1 | 1) => { const p = [...s.priority]; const j = i + d; if (j < 0 || j >= p.length) return; [p[i], p[j]] = [p[j], p[i]]; set({ priority: p }) }
  async function save() {
    setBusy(true); setSaveErr('')
    try {
      const out = await reframeApi.saveSettings(s!)
      setV(out); setS(out.settings)
      notify({ kind: 'ok', message: 'Saved. New analyses and renders use these settings; assets already framed keep their framing until re-analysed.' })
    } catch (e: any) { setSaveErr(e?.message || 'Could not save') } finally { setBusy(false) }
  }

  return (
    <div className="rfs">
      <PageHead title="Formats and reframing" sub="Which social formats Volt makes from your 16:9 media, how it decides what to keep in frame, and when it runs. Operators can adjust any asset in its Formats tab."
        action={!ro ? <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button> : undefined} />
      {ro && <Notice kind="info" variant="compact" title="Read only" message="Only an admin or owner can change these settings." />}
      <FormStatus error={saveErr} />

      <div className="rfs-grid">
        <div className="rfs-col">
          <section className="card"><div className="card-b">
            <h3>Output formats</h3>
            <p className="rfs-hint">Each format is one extra encode per asset, made from the same tracking.</p>
            {v.formats.map((f) => (
              <label key={f.key} className="rfs-row">
                <input type="checkbox" checked={s.formats[f.key]} disabled={ro} onChange={(e) => set({ formats: { ...s.formats, [f.key]: e.target.checked } })} />
                <Shape k={f.key} />
                <span><b>{f.label}</b> <span className="mono faint">{f.width}×{f.height}</span><span className="rfs-hint">{f.for}</span></span>
              </label>
            ))}
            <div className="rfs-row dim"><input type="checkbox" checked disabled aria-label="16:9 source, always made" /><Shape k="16x9" />
              <span><b>16:9 source</b><span className="rfs-hint">YouTube, your portal and apps. Always made, no reframing.</span></span></div>
          </div></section>

          <section className="card"><div className="card-b">
            <h3>What to keep in frame</h3>
            <p className="rfs-hint">Volt follows the first of these it finds in each shot.</p>
            <ol className="rfs-prio">
              {s.priority.map((p, i) => (
                <li key={p}>
                  <span className="mono faint">{i + 1}</span><span className="grow">{FOLLOW_LABEL[p]}</span>
                  <button className="btn ghost sm" disabled={ro || i === 0} aria-label={`Move ${p} up`} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn ghost sm" disabled={ro || i === s.priority.length - 1} aria-label={`Move ${p} down`} onClick={() => move(i, 1)}>↓</button>
                </li>
              ))}
            </ol>
            <span className="lbl">Camera movement</span>
            <div className="rf-seg" role="group" aria-label="Camera movement">
              {(['responsive', 'steady', 'locked'] as const).map((m) => <button key={m} type="button" disabled={ro} className={s.movement === m ? 'on' : ''} aria-pressed={s.movement === m} onClick={() => set({ movement: m })}>{m === 'steady' ? 'Steady' : m === 'responsive' ? 'Responsive' : 'Locked per shot'}</button>)}
            </div>
            <p className="rfs-hint">{s.movement === 'steady' ? 'Holds the framing still inside a shot, and pans smoothly only when the subject would leave it.' : s.movement === 'responsive' ? 'Follows the subject closely, with light smoothing.' : 'One framing per shot, never moves inside a shot.'}</p>
            <span className="lbl">When the subjects will not fit</span>
            <div className="rf-seg" role="group" aria-label="When the subjects will not fit">
              {(['fill', 'follow'] as const).map((m) => <button key={m} type="button" disabled={ro} className={s.fallback === m ? 'on' : ''} aria-pressed={s.fallback === m} onClick={() => set({ fallback: m })}>{m === 'fill' ? 'Whole picture on a blurred fill' : 'Follow the main subject'}</button>)}
            </div>
            <Toggle checked={s.safeArea} disabled={ro} onChange={(x) => set({ safeArea: x })} hint="9:16 only: keeps the subject left of the buttons TikTok, Reels and Shorts draw on the right.">Keep faces clear of the platform's buttons</Toggle>
          </div></section>
        </div>

        <div className="rfs-col">
          <section className="card"><div className="card-b">
            <h3>Publish targets</h3>
            <p className="rfs-hint">The format each platform receives when you publish to it.</p>
            <Toggle checked={s.renderOnPublish} disabled={ro} onChange={(x) => set({ renderOnPublish: x })}
              hint="Off: every platform receives the 16:9 file, as before. On: the format below, rendered when published if it is not made yet, and refused until approved when approval is required.">Send each platform its own format</Toggle>
            {v.platforms.map((p) => (
              <div key={p.key} className="rfs-row">
                <span className="grow"><b>{p.label}</b><span className="rfs-hint">{p.accounts.length ? p.accounts.map((a) => a.name).join(', ') : 'No account linked'}</span></span>
                <select aria-label={`${p.label} format`} value={s.targets[p.key] ?? '16x9'} disabled={ro || !s.renderOnPublish}
                  onChange={(e) => set({ targets: { ...s.targets, [p.key]: e.target.value as TargetFormat } })}>
                  {(['16x9', '9x16', '1x1', '4x5'] as TargetFormat[]).map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
                </select>
              </div>
            ))}
          </div></section>

          <section className="card"><div className="card-b">
            <h3>When it runs</h3>
            <Toggle checked={s.autoAnalyse} disabled={ro} onChange={(x) => set({ autoAnalyse: x })} hint="Tracking only, at a fraction of the running time. Makes the Formats tab ready the moment you open it.">Analyse every new clip and asset</Toggle>
            <Toggle checked={s.requireApproval} disabled={ro} onChange={(x) => set({ requireApproval: x })} hint="A format must be approved in the asset's Formats tab before it is published. A change to the framing takes the approval away.">A person approves the framing before publishing</Toggle>
            <Toggle checked={s.autoApproveAbove != null} disabled={ro || !s.requireApproval} onChange={(x) => set({ autoApproveAbove: x ? 0.9 : null })}
              hint="Volt approves a format itself when it is this sure of every shot. Shots it is less sure of (two people too far apart, nobody on screen long enough) still wait for a person.">
              Approve automatically when every shot's confidence is at least <span className="mono">{(s.autoApproveAbove ?? 0.9).toFixed(2)}</span>
            </Toggle>
          </div></section>

          <section className="card"><div className="card-b">
            <h3>Processing</h3>
            <div className="rfs-facts">
              <div><span className="lbl">Tracking runs on</span><span>{v.engine.tracking}</span></div>
              <div><span className="lbl">Faces</span><span>{v.engine.faces}</span></div>
              <div><span className="lbl">Shot changes</span><span>{v.engine.shots}</span></div>
            </div>
            {v.updatedAt && <p className="rfs-hint">Last changed by {v.updatedBy ?? 'someone'}, {new Date(v.updatedAt).toLocaleString()}.</p>}
          </div></section>
        </div>
      </div>
    </div>
  )
}
