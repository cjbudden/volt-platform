// ============================================================================
//  FILE-NAME RULES (on the Ingest Rules page): what a file name says about the
//  content type, and how much of it is applied without asking.
//
//  IF the name contains a word, a pattern or a signal (season and episode
//  markers, a promo marker) THEN suggest a content type. The account's rules
//  outrank the built-in ones, which can be switched off but not edited. The
//  test box shows exactly what a name would give, with the reasons, so a rule
//  can be checked before a file arrives.
// ============================================================================
import { useEffect, useState } from 'react'
import { Notice, useNotify } from '../notices'
import { filenameRulesApi, type FnRule, type FnSettings } from './vod/libraryApi'
import '../contentLink.css'

const SIGNALS: Record<string, string> = {
  promo: 'A promotional marker (trailer, teaser, promo)', seasonEpisode: 'Season and episode (S01E03)', episode: 'An episode number only',
  season: 'A season only', year: 'A year', date: 'A date', language: 'A language code',
}
const lbl = { display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' } as const

function RuleEditor({ rule, types, onSaved, onCancel }: { rule: Partial<FnRule>; types: { id: string; name: string; key: string | null }[]; onSaved: () => void; onCancel: () => void }) {
  const [r, setR] = useState<Partial<FnRule>>({ enabled: true, ordinal: 100, confidence: 0.85, when: {}, then: {}, ...rule })
  const [err, setErr] = useState('')
  const typeVal = r.then?.typeId ?? (r.then?.typeKey ? types.find((t) => t.key === r.then!.typeKey)?.id : '') ?? ''
  async function save() {
    setErr('')
    const t = types.find((x) => x.id === typeVal)
    const body = { name: r.name || 'Untitled rule', enabled: r.enabled, ordinal: r.ordinal, confidence: r.confidence,
      when: Object.fromEntries(Object.entries(r.when ?? {}).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))),
      then: t ? (t.key ? { typeKey: t.key, ...(r.then?.kind ? { kind: r.then.kind } : {}) } : { typeId: t.id }) : {} }
    try { if (r.id) await filenameRulesApi.update(r.id, body); else await filenameRulesApi.create(body); onSaved() } catch (e: any) { setErr(e.message) }
  }
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 10, margin: '8px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Name</span><input value={r.name ?? ''} onChange={(e) => setR({ ...r, name: e.target.value })} /></label>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Order (lower first)</span><input type="number" value={r.ordinal ?? 100} onChange={(e) => setR({ ...r, ordinal: Number(e.target.value) })} /></label>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>How sure a match is (10 to 98%)</span><input type="number" min={10} max={98} value={Math.round((r.confidence ?? 0.85) * 100)} onChange={(e) => setR({ ...r, confidence: Number(e.target.value) / 100 })} /></label>
      </div>
      <div className="sec-label">If the file name has (every condition set must hold)</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Any of these words (comma separated)</span>
          <input value={(r.when?.words ?? []).join(', ')} placeholder="pkg, vo, sot" onChange={(e) => setR({ ...r, when: { ...r.when, words: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} /></label>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>A signal</span>
          <select value={r.when?.signal ?? ''} onChange={(e) => setR({ ...r, when: { ...r.when, signal: e.target.value || undefined } })}>
            <option value="">None</option>{Object.entries(SIGNALS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Pattern (regular expression on the lower-case name)</span>
          <input value={r.when?.pattern ?? ''} placeholder="^abc " onChange={(e) => setR({ ...r, when: { ...r.when, pattern: e.target.value || undefined } })} /></label>
      </div>
      <div className="sec-label">Then suggest</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Content type</span>
          <select value={typeVal} onChange={(e) => setR({ ...r, then: { typeId: e.target.value || undefined } })}>
            <option value="">Choose a type</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {types.find((t) => t.id === typeVal)?.key === 'trailer' && (
          <label style={lbl}><span style={{ color: 'var(--muted)' }}>Kind</span>
            <select value={r.then?.kind ?? ''} onChange={(e) => setR({ ...r, then: { ...r.then, kind: e.target.value || undefined } })}>
              <option value="">From the word found</option>{['Trailer', 'Teaser', 'Promo', 'Featurette', 'Clip'].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        )}
      </div>
      <div className="lib-faint lib-small">The words a rule recognises are also taken out of the title. Your rules outrank the built-in ones.</div>
      {err && <Notice kind="error" variant="compact" message={err} />}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={save}>Save rule</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

const condition = (r: FnRule) => [
  r.when.words?.length ? `the words ${r.when.words.map((w) => `"${w}"`).join(' or ')}` : '',
  r.when.signal ? (SIGNALS[r.when.signal] ?? r.when.signal).toLowerCase() : '',
  r.when.pattern ? `the pattern /${r.when.pattern}/` : '',
].filter(Boolean).join(' and ')

export function FilenameRulesCard() {
  const [data, setData] = useState<Awaited<ReturnType<typeof filenameRulesApi.list>> | null>(null)
  const [editing, setEditing] = useState<Partial<FnRule> | null>(null)
  const [name, setName] = useState('Movie_Title_2025_Official_Trailer_1080p.mp4')
  const [test, setTest] = useState<Awaited<ReturnType<typeof filenameRulesApi.test>> | null>(null)
  const [err, setErr] = useState('')
  const notify = useNotify()
  const load = () => filenameRulesApi.list().then((d) => { setData(d); setErr('') }).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])
  async function settings(patch: Partial<FnSettings>) {
    try { const s = await filenameRulesApi.settings(patch); setData((d) => d ? { ...d, settings: s } : d) } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  async function runTest() { try { setTest(await filenameRulesApi.test(name)) } catch (e: any) { notify({ kind: 'error', message: e.message }) } }
  if (err) return <Notice kind="error" variant="compact" title="Couldn't load the file-name rules." message={err} />
  if (!data) return <div className="loading">Loading file-name rules…</div>
  const s = data.settings
  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="sec-label" style={{ margin: 0 }}>File names: content type, title and links</div>
        <div className="flex-1" style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => setEditing({})}>Add rule</button>
      </div>
      <div className="lib-faint lib-small" style={{ margin: '6px 0 12px' }}>
        A file name says a lot: <code>S01E03</code> makes an episode, <code>Official_Trailer</code> a trailer, <code>2025</code> a year. These are signals, not facts:
        a type a person or an ingest rule chose is never changed, values people typed are kept, and anything uncertain is offered on the asset for a person to choose.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 12 }}>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Title case</span>
          <select value={s.titleCase} onChange={(e) => settings({ titleCase: e.target.value as any })}>
            <option value="every">Every word capitalised (7th Voyage Of Sinbad)</option>
            <option value="headline">Headline style (7th Voyage of Sinbad)</option>
          </select></label>
        <label style={lbl}><span style={{ color: 'var(--muted)' }}>Episode title when the name has none</span>
          <input defaultValue={s.episodeTemplate} onBlur={(e) => e.target.value !== s.episodeTemplate && settings({ episodeTemplate: e.target.value })} /></label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={s.autoType} onChange={(e) => settings({ autoType: e.target.checked })} />Set the content type when the name is clear (80% or more, no conflict)</label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
          <input type="checkbox" checked={s.autoLink} onChange={(e) => settings({ autoLink: e.target.checked })} />Link a trailer to its film when one record matches clearly</label>
      </div>

      <div className="sec-label">Try a file name</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ flex: 1, minWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runTest() }} aria-label="File name to test" />
        <button className="btn" onClick={runTest}>Test</button>
      </div>
      {test && (
        <div style={{ marginTop: 8 }}>
          <div className="fn-tokens">{test.signals.map((sg, i) => <span key={i} className={`fn-tok${sg.inTitle ? ' kept' : ''}`} title={sg.reason}><code>{sg.token}</code><span>{sg.kind}{sg.inTitle ? ', kept in the title' : ''}</span></span>)}</div>
          <div style={{ fontSize: 'var(--fs-sm)' }}><b>{test.suggestedType ? test.suggestedType.name : 'No type suggested'}</b>. {test.classification.conflict?.reason ?? test.classification.summary}</div>
          <ul className="lib-small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {test.parsed.series && <li>Series: {test.parsed.series}</li>}
            {test.fields.map((f) => <li key={f.field}>{f.label}: <b>{typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)}</b> <span className="lib-faint">{f.reason}</span></li>)}
            {test.lookFor && <li>Looks for the record it promotes: "{test.lookFor.title}"{test.lookFor.year ? ` (${test.lookFor.year})` : ''}</li>}
          </ul>
        </div>
      )}

      {editing && <RuleEditor rule={editing} types={data.types} onSaved={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} />}

      <div className="sec-label" style={{ marginTop: 14 }}>Your rules</div>
      {data.rules.length === 0 && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>None yet. Add one for your own naming, for example <code>pkg</code> for a news package.</div>}
      {data.rules.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)', opacity: r.enabled ? 1 : .5 }}>
          <span style={{ minWidth: 160 }}><strong>{r.name}</strong></span>
          <span style={{ flex: 1, color: 'var(--muted)', fontSize: 'var(--fs-xs)' }}>If {condition(r)}, then {r.typeName ?? 'a type'}{r.then.kind ? ` (${r.then.kind})` : ''}, {Math.round(r.confidence * 100)}%</span>
          <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => filenameRulesApi.update(r.id, { enabled: !r.enabled }).then(load)}>{r.enabled ? 'Disable' : 'Enable'}</button>
          <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => setEditing(r)}>Edit</button>
          <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) filenameRulesApi.remove(r.id).then(load) }}>Delete</button>
        </div>
      ))}

      <div className="sec-label" style={{ marginTop: 14 }}>Built-in rules</div>
      {data.builtin.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)', opacity: r.enabled ? 1 : .5 }}>
          <span style={{ flex: 1 }}>{r.name} <span style={{ color: 'var(--muted)', fontSize: 'var(--fs-xs)' }}>then {r.typeName ?? r.then.typeKey}, {Math.round(r.confidence * 100)}%</span></span>
          <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => filenameRulesApi.builtin(r.id, !r.enabled).then(load)}>{r.enabled ? 'Switch off' : 'Switch on'}</button>
        </div>
      ))}
    </div>
  )
}
