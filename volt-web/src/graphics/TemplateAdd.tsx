// Add a template: upload a package, paste HTML, or start from a Volt template.
// All three make a DRAFT and open it, where the checks, the preview and
// Publish live (TemplateDetail.tsx).
import { useEffect, useRef, useState } from 'react'
import { navigate } from '../router'
import { PageHead } from '../scaffold'
import { Notice } from '../notices'
import { gfx, KIND_LABEL, type Kind, type Template } from './gfxApi'
import { GraphicStage } from './GraphicStage'

type Method = 'upload' | 'paste' | 'copy'

const STARTER = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<!-- Fields an operator, a data feed or the API can fill. -->
<script type="application/json" id="volt-manifest">
{
  "name": "My lower third",
  "canvas": [1920, 1080],
  "fields": [
    {"id": "name", "type": "text", "label": "Name"},
    {"id": "title", "type": "text", "label": "Title"}
  ],
  "sample": {"name": "Jo Citizen", "title": "Reporter"}
}
</script>
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; background: transparent; overflow: hidden; font-family: Arial, sans-serif; }
  #g { position: absolute; left: 140px; bottom: 120px; opacity: 0; transition: opacity .4s; }
  #g.on { opacity: 1; }
  #name { background: #fff; color: #111; font: 800 46px Arial, sans-serif; padding: 12px 28px; }
  #title { background: #0b3a8a; color: #fff; font: 600 28px Arial, sans-serif; padding: 9px 28px; display: inline-block; }
</style>
</head>
<body>
<div id="g"><div id="name"></div><div id="title"></div></div>
<script>
  // The CasparCG contract: update(json), play(), stop(), next().
  function update(raw) {
    var d = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
    if ('name' in d) document.getElementById('name').textContent = d.name;
    if ('title' in d) document.getElementById('title').textContent = d.title;
  }
  function play() { document.getElementById('g').classList.add('on'); }
  function stop() { document.getElementById('g').classList.remove('on'); }
  function next() {}
</script>
</body>
</html>
`

export function TemplateAdd() {
  const [method, setMethod] = useState<Method>('upload')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('other')
  const [html, setHtml] = useState(STARTER)
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [volt, setVolt] = useState<Template[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (method === 'copy' && !volt) gfx.templates().then((r) => setVolt(r.items)).catch((e) => setErr(e.message)) }, [method, volt])

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (!/\.(zip|html?)$/i.test(f.name)) { setErr('Choose a .zip package or an .html file.'); return }
    if (f.size > 25 * 1024 * 1024) { setErr('The package is larger than 25 MB.'); return }
    setErr(''); setFile(f)
    if (!name) setName(f.name.replace(/\.(zip|html?)$/i, '').replace(/[-_]+/g, ' '))
  }
  const create = async () => {
    setErr(''); setBusy(true)
    try {
      let t: Template
      if (method === 'upload') {
        if (!file) throw new Error('Choose a file to upload.')
        t = await gfx.upload(file, { name: name.trim() || undefined, kind, filename: file.name })
      } else {
        if (!html.trim()) throw new Error('Paste the template HTML.')
        t = await gfx.paste({ html, name: name.trim() || undefined, kind })
      }
      navigate(`/graphics/templates/${t.id}`)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const duplicate = async (t: Template) => {
    setBusy(true); setErr('')
    try { const c = await gfx.duplicate(t.id, `${t.name} (copy)`); navigate(`/graphics/templates/${c.id}`) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const M = ({ k, title, desc, icon }: { k: Method; title: string; desc: string; icon: string }) => (
    <button type="button" className={`gfx-method ${method === k ? 'on' : ''}`} onClick={() => { setMethod(k); setErr('') }} aria-pressed={method === k}>
      <span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg></span>
      <span><b>{title}</b><span className="d">{desc}</span></span>
    </button>
  )

  return (
    <>
      <div className="gfx-meta" style={{ marginBottom: 6 }}><a href="/graphics" onClick={(e) => { e.preventDefault(); navigate('/graphics') }}>Graphics</a> / Add template</div>
      <PageHead title="Add a template" sub="Any HTML graphic built for CasparCG, SPX or Loopic works, and EBU OGraf packages (a .zip with a .ograf.json manifest). It runs sandboxed: no network, no access to Volt, and everything it needs comes inside the package."
        action={<button className="btn ghost" onClick={() => navigate('/graphics')}>Cancel</button>} />
      <div className="gfx-methods">
        <M k="upload" title="Upload a package" desc="A .zip with index.html, fonts and images, or a single .html file" icon="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        <M k="paste" title="Paste HTML" desc="Paste or write the code, then check it" icon="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
        <M k="copy" title="Start from a template" desc="Copy a Volt template or one of yours and change it; the original stays as it is" icon="M9 9h11v11H9zM5 15H4V4h11v1" />
      </div>
      {err && <Notice kind="error" message={err} />}

      {method === 'copy' ? (
        <div className="card">
          {!volt ? <div className="loading">Loading…</div> : volt.filter((t) => t.latest).map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 128, flex: 'none' }}><GraphicStage focus={t.latest!.manifest.bbox} layers={[{ key: t.id, url: t.latest!.url, values: t.latest!.manifest.sample, onAir: true }]} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{t.name} {t.owner === 'volt' ? <span className="tag gfx-volt">Volt</span> : null}</div>
                <div className="gfx-meta">{KIND_LABEL[t.kind]} · v{t.latest!.version} · {t.latest!.manifest.fields.length} fields</div>
              </div>
              <button className="btn ghost sm" disabled={busy} onClick={() => duplicate(t)}>Duplicate</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="gfx-split">
          <div className="main">
            {method === 'upload' ? (
              <div className="card card-b">
                <div className={`gfx-drop ${over ? 'over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
                  onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files?.[0]) }}>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>
                  <div style={{ fontWeight: 650 }}>{file ? file.name : 'Drop a .zip or .html here'}</div>
                  <div className="gfx-meta">{file ? `${(file.size / 1024).toFixed(1)} KB` : 'Up to 25 MB. Fonts, images and scripts must be inside the package.'}</div>
                  <input ref={input} type="file" accept=".zip,.html,.htm,application/zip,text/html" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
                  <button className="btn ghost sm" onClick={() => input.current?.click()}>{file ? 'Choose another' : 'Choose file'}</button>
                </div>
                <div className="sec-label">What a package looks like</div>
                <pre className="gfx-code" style={{ minHeight: 0, resize: 'none' }}>{`my-graphic/
  index.html     the graphic, 1920×1080, transparent background
  volt.json      optional: name, canvas, fields, sample data
  fonts/  images/  js/`}</pre>
              </div>
            ) : (
              <div className="card card-b">
                <label className="sec-label" htmlFor="gfx-html" style={{ display: 'block', marginTop: 0 }}>index.html</label>
                <textarea id="gfx-html" className="gfx-code" spellCheck={false} value={html} onChange={(e) => setHtml(e.target.value)} />
                <div className="gfx-meta" style={{ marginTop: 8 }}>Fonts and images can be added afterwards by uploading the whole package as a new version.</div>
              </div>
            )}
          </div>
          <div className="side">
            <div className="card card-b">
              <div className="field"><label htmlFor="gfx-name">Name</label>
                <input id="gfx-name" className="inp" placeholder="From the template if left empty" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field"><label htmlFor="gfx-kind">Kind</label>
                <select id="gfx-kind" className="inp" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={create}>
                {busy ? 'Checking…' : 'Check and save draft'}</button>
              <div className="gfx-meta" style={{ marginTop: 10 }}>Next you see it rendered, the fields it found and what to fix. Nothing is used anywhere until you publish it.</div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
