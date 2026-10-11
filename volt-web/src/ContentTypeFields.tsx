// ============================================================================
//  Content types on forms: the type picker, and the metadata form the chosen
//  type dictates.
//
//  A radio station, a TV channel and an event always have a type, so the
//  picker never offers "none": it lists the types offered for that owner
//  kind (standard first) and defaults to the standard one. The form renders
//  the type's effective fields (parent fields included), one control per
//  field type, and hands back the values object the API validates.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type ContentType, type SchemaField } from './api'

export function TypePicker({ appliesTo, value, onChange, disabled, hint }: {
  appliesTo: 'radio' | 'tv' | 'event' | 'vod'
  value: string | null
  onChange: (id: string, type: ContentType) => void
  disabled?: boolean
  hint?: string
}) {
  const [types, setTypes] = useState<ContentType[] | null>(null)
  useEffect(() => { api.contentTypes(appliesTo).then(setTypes).catch(() => setTypes([])) }, [appliesTo])
  // Default to the standard type for the kind the moment the list arrives.
  useEffect(() => {
    if (!types?.length || value) return
    const std = types.find(t => t.is_standard && t.applies_to.includes(appliesTo)) ?? types[0]
    onChange(std.id, std)
    /* eslint-disable-next-line */
  }, [types])
  const cur = types?.find(t => t.id === value) ?? null
  return (
    <div className="field">
      <label>Content type</label>
      <select className="inp" value={value ?? ''} disabled={disabled || !types}
        onChange={e => { const t = types?.find(x => x.id === e.target.value); if (t) onChange(t.id, t) }}>
        {!types && <option value="">Loading…</option>}
        {types?.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_standard ? '' : ' (custom)'}</option>)}
      </select>
      <div className="hintxt">
        {cur?.description || hint || 'Decides which metadata is captured here, on everything recorded or cut from it, and which EPG fields it fills.'}
        {cur?.schema_org_type && <span style={{ color: 'var(--faint)' }}> · schema.org {cur.schema_org_type}</span>}
      </div>
    </div>
  )
}

/** Turn a stored value into what the control shows, and back. */
const toText = (v: any) => v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? (v.name ?? JSON.stringify(v)) : String(v)

export function MetadataForm({ typeId, value, onChange, compact, entityName, hide }: {
  typeId: string | null
  value: Record<string, any>
  onChange: (v: Record<string, any>) => void
  compact?: boolean
  /**
   * For a channel, station or event. Its name (Settings) IS the metadata name:
   * the server always writes it there, so the type's `name` field is not shown
   * as a second box to fill in. The name is shown read-only instead.
   */
  entityName?: { value: string; where: string }
  /** Field keys another part of the form already sets (a channel's logo is its Guide icon). */
  hide?: string[]
}) {
  const [fields, setFields] = useState<SchemaField[] | null>(null)
  useEffect(() => {
    if (!typeId) { setFields([]); return }
    setFields(null)
    api.contentTypeFields(typeId).then(r => setFields(r.fields)).catch(() => setFields([]))
  }, [typeId])
  if (!typeId) return null
  if (!fields) return <div className="loading">Loading fields…</div>
  if (!fields.length) return <div className="hintxt">This type has no fields.</div>
  const set = (k: string, v: any) => {
    const next = { ...value }
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete next[k]; else next[k] = v
    onChange(next)
  }
  const shown = fields.filter(f => !(entityName && f.key === 'name') && !hide?.includes(f.key))
  const nameField = entityName ? fields.find(f => f.key === 'name') : undefined
  return (
    <div style={compact ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 14px' } : undefined}>
      {entityName && (
        <div className="field">
          <label>{nameField?.label || 'Name'}{nameField?.epg && <span style={{ marginLeft: 6, fontSize: 'var(--fs-micro)', color: 'var(--faint)', fontWeight: 400 }}>→ EPG {nameField.epg}</span>}</label>
          <div className="meta-name-ro" aria-readonly="true">{entityName.value.trim() || <span style={{ color: 'var(--faint)', fontWeight: 400 }}>Not named yet</span>}</div>
          <div className="hintxt">The {entityName.where} name, set on Settings. It is the name in the metadata and the guide.</div>
        </div>
      )}
      {shown.map(f => {
        const v = value[f.key]
        const label = <label>{f.label || f.key}{f.required && <span style={{ color: 'var(--warn,#fbbf24)' }}> *</span>}
          {f.epg && <span style={{ marginLeft: 6, fontSize: 'var(--fs-micro)', color: 'var(--faint)', fontWeight: 400 }}>→ EPG {f.epg}</span>}</label>
        if (f.type === 'boolean') return (
          <div key={f.key} className="field"><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={!!v} onChange={e => set(f.key, e.target.checked)} />{f.label || f.key}</label></div>)
        if (f.type === 'enum') return (
          <div key={f.key} className="field">{label}
            {f.multiple ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(f.options ?? []).map(o => {
                  const sel = Array.isArray(v) && v.includes(o)
                  return <button key={o} type="button" className={`chip ${sel ? 'active' : ''}`} style={{ padding: '3px 10px', fontSize: 'var(--fs-xs)' }}
                    onClick={() => set(f.key, sel ? (v as string[]).filter(x => x !== o) : [...(Array.isArray(v) ? v : []), o])}>{o}</button>
                })}
              </div>
            ) : (
              <select className="inp" value={v ?? ''} onChange={e => set(f.key, e.target.value)}>
                <option value="">—</option>
                {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </div>)
        if (f.type === 'text') return (
          <div key={f.key} className="field" style={compact ? { gridColumn: '1 / -1' } : undefined}>{label}
            <textarea className="inp" rows={3} value={toText(v)} onChange={e => set(f.key, e.target.value)} /></div>)
        if (f.type === 'tags') return (
          <div key={f.key} className="field">{label}
            <input className="inp" value={toText(v)} placeholder="comma separated"
              onChange={e => set(f.key, e.target.value.split(',').map(x => x.trim()).filter(Boolean))} /></div>)
        if (f.type === 'number') return (
          <div key={f.key} className="field">{label}
            <input className="inp" type="number" value={v ?? ''} onChange={e => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} /></div>)
        if (f.type === 'date') return (
          <div key={f.key} className="field">{label}
            <input className="inp" type="date" value={toText(v).slice(0, 10)} onChange={e => set(f.key, e.target.value)} /></div>)
        // string | url | reference (a reference is entered by name until the entity picker exists)
        return (
          <div key={f.key} className="field">{label}
            <input className="inp" type={f.type === 'url' ? 'url' : 'text'} value={toText(v)}
              placeholder={f.type === 'reference' ? `${f.refDomain ?? 'entity'} name` : undefined}
              onChange={e => set(f.key, f.type === 'reference' ? (e.target.value ? { name: e.target.value } : '') : e.target.value)} /></div>)
      })}
    </div>
  )
}
