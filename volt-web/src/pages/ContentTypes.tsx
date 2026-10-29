// ============================================================================
//  CONTENT TYPES — the metadata a radio station, a channel, an event or an
//  on-demand asset carries, by type.
//
//  Every account has the standard types (schema.org-based, seeded, never
//  deleted). A type can be edited (fields added, relabelled, made required,
//  mapped to an EPG slot), cloned into a custom type, or a new custom type
//  created that extends another. The right-hand pane is the field editor.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type ContentType, type SchemaField } from '../api'
import { PageHead } from '../scaffold'
import { RuleEditor } from '../RuleEditor'
import { useNotify, usePageNotice } from '../notices'
import { navigate } from '../router'

const APPLIES: { key: 'radio' | 'tv' | 'event' | 'vod'; label: string }[] = [
  { key: 'radio', label: 'Radio stations' }, { key: 'tv', label: 'TV channels' }, { key: 'event', label: 'Events' }, { key: 'vod', label: 'On-demand assets' },
]
const FIELD_TYPES: SchemaField['type'][] = ['string', 'text', 'number', 'boolean', 'date', 'enum', 'url', 'image', 'tags', 'reference', 'content']
const EPG_SLOTS = ['', 'title', 'sub-title', 'description', 'category', 'episode', 'language', 'icon', 'credits.presenter', 'credits.actor', 'credits.commentator', 'credits.producer', 'credits.director', 'credits.guest']

export default function ContentTypesPage() {
  const [types, setTypes] = useState<ContentType[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | 'radio' | 'tv' | 'event' | 'vod'>('all')
  async function load() { try { const t = await api.contentTypes(); setTypes(t); setErr(''); if (!sel && t.length) setSel(t[0].id) } catch (e: any) { setErr(e.message) } }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [])
  const notify = useNotify()
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load content types.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)
  const cur = types?.find(t => t.id === sel) ?? null
  const shown = (types ?? []).filter(t => filter === 'all' || t.applies_to.includes(filter))
  return (
    <>
      <PageHead title="Content Types" sub="What metadata each kind of content carries, and which EPG fields it fills. Standard types are schema.org-based; edit them or add your own." />
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {(['all', 'radio', 'tv', 'event', 'vod'] as const).map(f => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)' }} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : APPLIES.find(a => a.key === f)!.label}
              </button>
            ))}
          </div>
          {!types ? <div className="loading">Loading…</div> : shown.map(t => (
            <div key={t.id} onClick={() => setSel(t.id)} style={{ padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: sel === t.id ? 'rgba(63,123,255,.12)' : 'transparent', border: `1px solid ${sel === t.id ? 'rgba(63,123,255,.4)' : 'transparent'}`, marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b style={{ fontSize: 'var(--fs-body)' }}>{t.name}</b>
                {t.is_standard && <span className="tag" style={{ fontSize: 'var(--fs-micro)' }}>standard</span>}
              </div>
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--faint)' }}>
                {t.applies_to.map(a => APPLIES.find(x => x.key === a)?.label ?? a).join(', ') || 'any'}{t.schema_org_type ? ` · ${t.schema_org_type}` : ''} · {t.fields.length} field{t.fields.length === 1 ? '' : 's'}
              </div>
            </div>
          ))}
          <button className="btn ghost" style={{ marginTop: 8, width: '100%' }} onClick={async () => {
            try {
              const base = cur
              const created = await api.createContentType({
                name: `${base?.name ?? 'Custom type'} (copy)`, description: base?.description ?? undefined, fields: [],
                targetKind: base?.target_kind ?? 'any', domain: base?.domain ?? undefined, extendsId: base?.id,
                appliesTo: base?.applies_to ?? ['event'], schemaOrgType: base?.schema_org_type ?? undefined,
              })
              await load(); setSel(created.id)
            } catch (e: any) { notify({ kind: 'error', message: e.message }) }
          }}>{cur ? `New type extending ${cur.name}` : 'New type'}</button>
        </div>
        <div>
          {cur ? <TypeEditor key={cur.id} type={cur} all={types ?? []} onChanged={load} onDeleted={() => { setSel(null); load() }} /> : <div className="card" style={{ padding: 18, color: 'var(--faint)' }}>Choose a type.</div>}
        </div>
      </div>
    </>
  )
}

function TypeEditor({ type, all, onChanged, onDeleted }: { type: ContentType; all: ContentType[]; onChanged: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(type.name)
  const [desc, setDesc] = useState(type.description ?? '')
  const [applies, setApplies] = useState<ContentType['applies_to']>(type.applies_to)
  const [fields, setFields] = useState<SchemaField[]>(type.fields)
  const [inherited, setInherited] = useState<SchemaField[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const parent = all.find(t => t.id === type.extends_id) ?? null
  useEffect(() => {
    if (!type.extends_id) { setInherited([]); return }
    api.contentTypeFields(type.extends_id).then(r => setInherited(r.fields)).catch(() => setInherited([]))
  }, [type.extends_id])

  const setField = (i: number, patch: Partial<SchemaField>) => setFields(fs => fs.map((f, k) => k === i ? { ...f, ...patch } : f))
  async function save() {
    setBusy(true); setErr(''); setMsg('')
    try {
      await api.patchContentType(type.id, { name: name.trim(), description: desc, fields, appliesTo: applies })
      setMsg('Saved.'); onChanged()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const inp = { className: 'inp', style: { fontSize: 'var(--fs-sm)', padding: '4px 7px' } as any }
  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <input className="inp" style={{ fontSize: 'var(--fs-h2)', fontWeight: 700, maxWidth: 380 }} value={name} onChange={e => setName(e.target.value)} />
        {type.is_standard && <span className="tag">standard{type.standard_key ? ` · ${type.standard_key}` : ''}</span>}
        {type.schema_org_type && <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>schema.org {type.schema_org_type}</span>}
        {parent && <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>extends {parent.name}</span>}
      </div>
      <div className="field" style={{ marginTop: 10 }}><label>Description</label>
        <input className="inp" value={desc} onChange={e => setDesc(e.target.value)} /></div>
      <div className="field"><label>Offered for</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {APPLIES.map(a => <button key={a.key} type="button" className={`chip ${applies.includes(a.key) ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)' }}
            onClick={() => setApplies(s => s.includes(a.key) ? s.filter(x => x !== a.key) : [...s, a.key])}>{a.label}</button>)}
        </div>
      </div>

      <div className="sec-label">Fields</div>
      {inherited.length > 0 && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--faint)', marginBottom: 8 }}>
          Inherited from {parent?.name}: {inherited.map(f => f.label || f.key).join(', ')}. A field here with the same key overrides it.
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Options / ref</th><th>Req.</th><th>EPG field</th><th>schema.org</th><th></th></tr></thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={i}>
                <td><input {...inp} value={f.key} onChange={e => setField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} style={{ ...inp.style, width: 120, fontFamily: 'ui-monospace,monospace' }} /></td>
                <td><input {...inp} value={f.label ?? ''} onChange={e => setField(i, { label: e.target.value })} style={{ ...inp.style, width: 150 }} /></td>
                <td><select className="inp sel-sm" value={f.type} onChange={e => setField(i, { type: e.target.value as any })}>{FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></td>
                <td>
                  {/* An enum takes its options from its own list, or from the
                      account's Genres list (Admin > Genres), filled in on save. */}
                  {f.type === 'enum' && (
                    <select className="inp sel-sm" aria-label={`Options for ${f.label || f.key}`} value={f.optionsList ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        if (v) setField(i, { optionsList: v as any })
                        else setField(i, { optionsList: undefined, retiredOptions: undefined, options: f.options ?? [] })
                      }} style={{ marginRight: 6 }}>
                      <option value="">Own list</option>
                      <option value="genres">Genres list</option>
                    </select>
                  )}
                  {f.type === 'enum' && f.optionsList && (
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--faint)' }}>
                      {f.options?.length ? `${f.options.length} values · ` : 'filled on save · '}
                      <a href="/genres" onClick={e => { e.preventDefault(); navigate('/genres') }}>manage</a>
                    </span>
                  )}
                  {f.type === 'enum' && !f.optionsList && <input {...inp} placeholder="a, b, c" value={(f.options ?? []).join(', ')} onChange={e => setField(i, { options: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} style={{ ...inp.style, width: 160 }} />}
                  {f.type === 'enum' && <label style={{ fontSize: 'var(--fs-micro)', marginLeft: 6 }}><input type="checkbox" checked={!!f.multiple} onChange={e => setField(i, { multiple: e.target.checked })} /> multi</label>}
                  {f.type === 'reference' && <input {...inp} placeholder="sports-team" value={f.refDomain ?? ''} onChange={e => setField(i, { refDomain: e.target.value })} style={{ ...inp.style, width: 120 }} />}
                  {/* content: a link to another library record (services/contentLinks.ts); the relation says which way it points. */}
                  {f.type === 'content' && (
                    <select className="inp sel-sm" aria-label="Relationship" value={f.relation ?? 'related'} onChange={e => setField(i, { relation: e.target.value })}>
                      <option value="trailer_for">Trailer or promo for</option>
                      <option value="related">Related to</option>
                    </select>
                  )}
                </td>
                <td><input type="checkbox" checked={!!f.required} onChange={e => setField(i, { required: e.target.checked })} /></td>
                <td><select className="inp sel-sm" value={f.epg ?? ''} onChange={e => setField(i, { epg: e.target.value || undefined })}>{EPG_SLOTS.map(sl => <option key={sl} value={sl}>{sl || '—'}</option>)}</select></td>
                <td><input {...inp} value={f.schemaOrg ?? ''} onChange={e => setField(i, { schemaOrg: e.target.value || undefined })} style={{ ...inp.style, width: 120 }} /></td>
                <td><button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => setFields(fs => fs.filter((_, k) => k !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setFields(fs => [...fs, { key: `field${fs.length + 1}`, label: '', type: 'string' }])}>Add field</button>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save type'}</button>
        {!type.is_standard && (
          <button className="btn ghost" disabled={busy} style={{ color: 'var(--down,#f87171)' }} onClick={async () => {
            if (!window.confirm(`Delete "${type.name}"? Refused if anything is assigned to it.`)) return
            try { await api.deleteContentType(type.id); onDeleted() } catch (e: any) { setErr(e.message) }
          }}>Delete type</button>
        )}
        {msg && <span style={{ color: 'var(--ok,#4ade80)', fontSize: 'var(--fs-sm)' }}>{msg}</span>}
        {err && <span style={{ color: '#fca5a5', fontSize: 'var(--fs-sm)' }}>{err}</span>}
      </div>

      {/* THE CONTENT TYPE RUNG of the publishing ladder: every asset of this
          type inherits these unless its channel, event, station or the asset
          itself says otherwise. */}
      <div className="sec-label" style={{ marginTop: 22 }}>Publishing rule for this type</div>
      <RuleEditor scopeKind="schema" scopeId={type.id} compact resolveQuery={{ schemaId: type.id }} />
    </div>
  )
}
