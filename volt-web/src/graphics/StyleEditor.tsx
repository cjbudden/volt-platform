// The look of a template: change the colours and fonts it already uses, and
// add a font file. Not a designer (GRAPHICS_TEMPLATE_STANDARD.md section 8):
// templates are designed in a graphics tool and imported; this adapts one to a
// brand. Every save is a new draft, checked like any other, so nothing on air
// changes until the draft is published and a setup moves to it.
import { useEffect, useMemo, useState } from 'react'
import { Notice } from '../notices'
import { gfx, type StyleReport, type StyleToken, type Version } from './gfxApi'

const GENERIC = ['sans-serif', 'serif', 'monospace', 'system-ui']
const toHex6 = (v: string) => {
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7)
  if (/^#[0-9a-f]{3,4}$/.test(s)) return '#' + [...s.slice(1, 4)].map((c) => c + c).join('')
  return null
}
const isColour = (v: string) => /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgba?|hsla?)\([^()]{3,60}\)|transparent)$/i.test(v.trim())
const readB64 = (f: File) => new Promise<string>((ok, no) => {
  const r = new FileReader(); r.onerror = () => no(r.error); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.readAsDataURL(f)
})

export function StyleEditor({ templateId, version, replacesDraft, onSaved, onClose }: {
  templateId: string; version: Version; replacesDraft: boolean
  onSaved: (v: Version) => void; onClose: () => void
}) {
  const [report, setReport] = useState<StyleReport | null>(null)
  const [changes, setChanges] = useState<Record<string, string>>({})
  const [fonts, setFonts] = useState<{ family: string; filename: string; base64: string }[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setReport(null); setChanges({}); setFonts([]); setErr('')
    gfx.style(templateId, version.id).then(setReport, (e) => setErr(e.message))
  }, [templateId, version.id])

  const colours = (report?.tokens ?? []).filter((t) => t.kind === 'color')
  const faces = (report?.tokens ?? []).filter((t) => t.kind === 'font')
  const families = useMemo(() => [...new Set([...(report?.fonts ?? []).map((f) => f.family), ...fonts.map((f) => f.family), ...GENERIC])], [report, fonts])
  const val = (t: StyleToken) => changes[t.id] ?? t.value
  const set = (t: StyleToken, v: string) => setChanges((c) => { const n = { ...c }; if (v === t.value) delete n[t.id]; else n[t.id] = v; return n })
  const bad = Object.entries(changes).filter(([id, v]) => colours.some((t) => t.id === id) && !isColour(v))
  const dirty = Object.keys(changes).length > 0 || fonts.length > 0

  const addFont = async (f: File | undefined) => {
    if (!f) return
    if (!/\.(woff2|woff|ttf|otf)$/i.test(f.name)) { setErr('Fonts must be .woff2, .woff, .ttf or .otf files.'); return }
    if (f.size > 4 * 1024 * 1024) { setErr(`${f.name} is larger than 4 MB.`); return }
    const family = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+(regular|bold|medium|light|semibold|italic|\d{3})$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 60) || 'Brand font'
    const base64 = await readB64(f)
    setFonts((x) => [...x, { family, filename: f.name, base64 }])
  }
  const save = async () => {
    setBusy(true); setErr('')
    try { onSaved(await gfx.saveStyle(templateId, { versionId: version.id, changes, addFonts: fonts })) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card card-b gfx-style">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <b>Customise the look</b>
        <span className="gfx-meta">From {version.status === 'draft' ? 'the draft' : `v${version.version}`}. Saving makes a draft; what is on air stays until you publish.</span>
      </div>
      {err && <Notice kind="error" message={err} />}
      {!report ? <div className="gfx-meta">Reading the template…</div> : (
        <>
          {!colours.length && !faces.length && <p className="gfx-meta">No colours or fonts found in this template's own files. Its look may come from images, or from a library it bundles.</p>}
          {colours.length > 0 && <>
            <div className="gfx-style-h">Colours</div>
            <div className="gfx-style-grid">
              {colours.map((t) => {
                const v = val(t); const hex = toHex6(v)
                return (
                  <div className={`gfx-style-row${changes[t.id] != null ? ' changed' : ''}`} key={t.id}>
                    <input type="color" aria-label={`${t.label} picker`} value={hex ?? '#000000'} onChange={(e) => set(t, e.target.value)} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="n">{t.via === 'var' ? t.label : <span className="mono">{t.value}</span>}</div>
                      <div className="gfx-meta">{t.via === 'var' ? `Theme variable ${t.id.slice(4)}` : `Used ${t.uses}×`}</div>
                    </div>
                    <input className="inp mono" aria-label={`${t.label} value`} value={v} onChange={(e) => set(t, e.target.value)} style={{ width: 128 }} aria-invalid={!isColour(v)} />
                    {changes[t.id] != null && <button className="btn ghost sm" onClick={() => set(t, t.value)} aria-label={`Undo ${t.label}`}>Undo</button>}
                  </div>)
              })}
            </div>
          </>}
          {(faces.length > 0 || fonts.length > 0) && <div className="gfx-style-h">Fonts</div>}
          {faces.length > 0 && <div className="gfx-style-grid">
            {faces.map((t) => (
              <div className={`gfx-style-row${changes[t.id] != null ? ' changed' : ''}`} key={t.id}>
                <span className="gfx-style-aa" aria-hidden="true">Aa</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="n">{t.via === 'var' ? t.label : t.value}</div>
                  <div className="gfx-meta">{t.via === 'var' ? `Theme variable ${t.id.slice(4)}` : `Used ${t.uses}×`}</div>
                </div>
                <select className="inp" aria-label={`Font for ${t.label}`} value={val(t)} onChange={(e) => set(t, e.target.value)} style={{ width: 190 }}>
                  {!families.includes(val(t)) && <option value={val(t)}>{val(t)}</option>}
                  {families.map((f) => <option key={f} value={f}>{f}{GENERIC.includes(f) ? ' (viewer\'s default)' : ''}</option>)}
                </select>
                {changes[t.id] != null && <button className="btn ghost sm" onClick={() => set(t, t.value)}>Undo</button>}
              </div>))}
          </div>}
          {fonts.map((f, i) => (
            <div className="gfx-style-row changed" key={i}>
              <span className="gfx-style-aa" aria-hidden="true">+</span>
              <div style={{ minWidth: 0, flex: 1 }}><div className="n">{f.filename}</div><div className="gfx-meta">Added to the package as</div></div>
              <input className="inp" aria-label={`Name for ${f.filename}`} value={f.family} onChange={(e) => setFonts((x) => x.map((y, j) => j === i ? { ...y, family: e.target.value } : y))} style={{ width: 190 }} />
              <button className="btn ghost sm" onClick={() => setFonts((x) => x.filter((_, j) => j !== i))}>Remove</button>
            </div>))}
          <label className="btn ghost sm" style={{ marginTop: 10, display: 'inline-flex' }}>
            Add a font file<input type="file" hidden accept=".woff2,.woff,.ttf,.otf" onChange={(e) => { addFont(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          <span className="gfx-meta" style={{ marginLeft: 10 }}>Bundled in the package, so it is there on air. Then choose it above.</span>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {replacesDraft && dirty && <span className="gfx-meta" style={{ color: 'var(--warn)' }}>This replaces the current draft.</span>}
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onClose}>Close</button>
        <button className="btn primary sm" disabled={!dirty || busy || bad.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save to draft and preview'}</button>
      </div>
    </div>
  )
}
