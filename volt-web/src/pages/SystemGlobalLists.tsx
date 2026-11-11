import { useEffect, useMemo, useRef, useState } from 'react'
import { apiRequest as req } from '../api'
import { Notice } from '../notices'
import { pressable } from '../a11y'
import { clearGlobalListCache } from '../lib/globalLists'

/* ============================================================================
   System Admin > Global lists. Reference lists that are the same for every
   client and kept by SaaS staff: Countries and Timezones ship built in, and
   new lists (languages, currencies, regions) can be made here without a
   deploy. Each list declares its fields; each item is a stable code plus
   those fields. Clients, players and the promo site read them from
   /api/global-lists. Server: volt-app/src/modules/globalLists.ts.

   Codes are what other records store, so built-in lists never delete an
   item: it is retired (still resolvable, no longer offered).
   ========================================================================== */

type FieldType = 'string' | 'number' | 'boolean' | 'string[]'
type Visibility = 'public' | 'tenant' | 'platform'
export interface FieldDef {
  key: string; label: string; type: FieldType; required?: boolean; unique?: boolean; pattern?: string
  maxLength?: number; case?: 'upper' | 'lower'; sortAs?: 'number'; description?: string
}
export interface GlobalList {
  id: string; key: string; name: string; description: string | null; visibility: Visibility; system: boolean
  codeField: string | null; labelField: string; fields: FieldDef[]; itemCount?: number; activeCount?: number
  version: number; archived: boolean; updatedAt: string
}
export interface GlobalListItem {
  id: string; listId: string; listKey: string; code: string; label: string; value: Record<string, any>
  position: number; isDefault: boolean; active: boolean; updatedAt: string
}
interface ImportSummary { created: number; updated: number; unchanged: number; retired: number; dryRun: boolean }

const J = (b: unknown) => ({ body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const P = '/platform/global-lists'
const gl = {
  lists: (): Promise<{ items: GlobalList[] }> => req(P),
  create: (b: Partial<GlobalList>): Promise<GlobalList> => req(P, { method: 'POST', ...J(b) }),
  patch: (key: string, b: Partial<GlobalList> & { archived?: boolean }): Promise<GlobalList> => req(`${P}/${key}`, { method: 'PATCH', ...J(b) }),
  items: (key: string, q: string, status: string): Promise<{ items: GlobalListItem[] }> => {
    const p = new URLSearchParams({ limit: '1000' })
    if (q.trim()) p.set('q', q.trim())
    if (status !== 'all') p.set('active', status === 'active' ? 'true' : 'false')
    return req(`${P}/${key}/items?${p}`)
  },
  addItem: (key: string, b: any): Promise<GlobalListItem> => req(`${P}/${key}/items`, { method: 'POST', ...J(b) }),
  patchItem: (key: string, ref: string, b: any): Promise<GlobalListItem> => req(`${P}/${key}/items/${encodeURIComponent(ref)}`, { method: 'PATCH', ...J(b) }),
  deleteItem: (key: string, ref: string) => req(`${P}/${key}/items/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  importItems: (key: string, b: { items: any[]; mode: 'merge' | 'replace'; dryRun: boolean }): Promise<ImportSummary> => req(`${P}/${key}/import`, { method: 'POST', ...J(b) }),
  exportList: (key: string): Promise<any> => req(`${P}/${key}/export`),
  restore: (key: string, overwrite: boolean): Promise<{ added: number; reset: number }> => req(`${P}/${key}/restore`, { method: 'POST', ...J({ overwrite }) }),
}

const errText = (e: any) => {
  const list: string[] | undefined = e?.body?.details?.errors
  return list?.length ? `${e.message}\n${list.slice(0, 12).map((x) => `• ${x}`).join('\n')}${list.length > 12 ? `\n… and ${list.length - 12} more` : ''}` : e?.message ?? String(e)
}
const VIS_LABEL: Record<Visibility, string> = { public: 'Public (no sign-in)', tenant: 'Signed-in clients', platform: 'System Admin only' }
const TYPE_LABEL: Record<FieldType, string> = { string: 'Text', number: 'Number', boolean: 'Yes / no', 'string[]': 'List of text' }
const show = (v: any) => (v == null || v === '' ? '—' : Array.isArray(v) ? (v.length ? `${v.slice(0, 2).join(', ')}${v.length > 2 ? ` +${v.length - 2}` : ''}` : '—') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v))

export function GlobalListsAdmin() {
  const [lists, setLists] = useState<GlobalList[] | null>(null)
  const [key, setKey] = useState<string>(() => new URLSearchParams(window.location.search).get('list') ?? '')
  const [items, setItems] = useState<GlobalListItem[] | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'retired'>('active')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [editing, setEditing] = useState<GlobalListItem | 'new' | null>(null)
  const [settings, setSettings] = useState<GlobalList | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState('')

  const list = lists?.find((l) => l.key === key) ?? null

  const loadLists = async () => {
    clearGlobalListCache()   // pickers elsewhere in this session read the change
    try {
      const r = await gl.lists(); setLists(r.items)
      if (!r.items.some((l) => l.key === key) && r.items[0]) setKey(r.items[0].key)
    } catch (e: any) { setErr(errText(e)) }
  }
  const loadItems = async () => {
    if (!key) return
    try { setItems((await gl.items(key, q, status)).items) } catch (e: any) { setErr(errText(e)) }
  }
  useEffect(() => { loadLists() }, [])
  useEffect(() => {
    setItems(null)
    if (key) window.history.replaceState(null, '', `?tab=lists&list=${key}`)
    const t = setTimeout(loadItems, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [key, q, status])

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setErr(''); setInfo('')
    try { await fn(); if (done) setInfo(done); await Promise.all([loadLists(), loadItems()]) } catch (e: any) { setErr(errText(e)) } finally { setBusy('') }
  }

  async function download() {
    if (!list) return
    await run('export', async () => {
      const data = await gl.exportList(list.key)
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = `volt-global-list-${list.key}-v${list.version}.json`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  // The columns: label first, then up to four other fields (code is its own column).
  const cols = useMemo(() => (list ? list.fields.filter((f) => f.key !== list.labelField && f.key !== list.codeField).slice(0, 4) : []), [list])

  if (!lists) return err ? <Notice kind="error" message={err} /> : <div className="loading">Loading global lists…</div>

  return (
    <>
      {err && <div style={{ marginBottom: 12, whiteSpace: 'pre-line' }}><Notice kind="error" message={err} /></div>}
      {info && <div style={{ marginBottom: 12 }}><Notice kind="ok" variant="compact" message={info} /></div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        {lists.map((l) => (
          <button key={l.key} className={`selchip ${l.key === key ? 'sel' : ''}`} style={l.archived ? { opacity: .55 } : undefined}
            aria-pressed={l.key === key} onClick={() => { setKey(l.key); setQ('') }}>
            {l.name} <span className="gfx-meta" style={{ marginLeft: 4 }}>{l.activeCount ?? 0}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setSettings('new')}>New list</button>
      </div>

      {list && (
        <>
          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 15 }}>{list.name}</strong>
                  <code className="gfx-meta">{list.key}</code>
                  {list.system && <span className="tag type">Built in</span>}
                  <span className={`tag ${list.visibility === 'public' ? 'live' : list.visibility === 'tenant' ? 'sched' : 'idle'}`}>{VIS_LABEL[list.visibility]}</span>
                  {list.archived && <span className="tag idle">Archived</span>}
                </div>
                {list.description && <div className="hintxt" style={{ marginTop: 4 }}>{list.description}</div>}
                <div className="gfx-meta" style={{ marginTop: 6 }}>
                  {list.activeCount} in use · {(list.itemCount ?? 0) - (list.activeCount ?? 0)} retired · version {list.version} · read at <code>/api/global-lists/{list.key}</code>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn ghost sm" onClick={() => setSettings(list)}>Fields and settings</button>
                <button className="btn ghost sm" onClick={() => setImporting(true)}>Import</button>
                <button className="btn ghost sm" disabled={busy === 'export'} onClick={download}>Export</button>
                {list.system && (
                  <button className="btn ghost sm" disabled={busy === 'restore'} title="Add any shipped items that are missing. Your edits are kept."
                    onClick={() => run('restore', async () => { const r = await gl.restore(list.key, false); setInfo(r.added ? `${r.added} shipped item${r.added === 1 ? '' : 's'} added back.` : 'Every shipped item is already here.') })}>
                    Restore shipped items</button>
                )}
              </div>
            </div>
          </div>

          <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input className="inp" style={{ flex: '1 1 240px', maxWidth: 360 }} placeholder={`Search ${list.name.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            {(['active', 'retired', 'all'] as const).map((s) => (
              <button key={s} className={`selchip ${status === s ? 'sel' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s === 'active' ? 'In use' : s === 'retired' ? 'Retired' : 'All'}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn primary sm" onClick={() => setEditing('new')}>Add item</button>
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th>Code</th><th>{list.fields.find((f) => f.key === list.labelField)?.label ?? 'Name'}</th>
                {cols.map((f) => <th key={f.key}>{f.label}</th>)}
                <th></th>
              </tr></thead>
              <tbody>
                {items === null ? <tr><td colSpan={cols.length + 3} className="loading">Loading…</td></tr>
                  : items.length === 0 ? <tr><td colSpan={cols.length + 3} className="hintxt">{q ? 'Nothing matches that search.' : 'No items here yet.'}</td></tr>
                  : items.map((it) => (
                    <tr key={it.id} style={!it.active ? { opacity: .55 } : undefined} {...pressable(() => setEditing(it))} data-a11y-click="">
                      <td><code>{it.code}</code></td>
                      <td>
                        {it.label}
                        {it.isDefault && <span className="tag type" style={{ marginLeft: 8 }}>Default</span>}
                        {!it.active && <span className="tag idle" style={{ marginLeft: 8 }}>Retired</span>}
                      </td>
                      {cols.map((f) => <td key={f.key} className="gfx-meta">{show(it.value[f.key])}</td>)}
                      <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEditing(it) }}>Edit</button></td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && list && (
        <ItemDrawer list={list} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); setInfo(msg); await Promise.all([loadLists(), loadItems()]) }} />
      )}
      {settings && (
        <ListDrawer list={settings === 'new' ? null : settings} onClose={() => setSettings(null)}
          onSaved={async (l, msg) => { setSettings(null); setInfo(msg); setKey(l.key); await loadLists() }} />
      )}
      {importing && list && (
        <ImportDrawer list={list} onClose={() => setImporting(false)}
          onDone={async (msg) => { setImporting(false); setInfo(msg); await Promise.all([loadLists(), loadItems()]) }} />
      )}
    </>
  )
}

/* ---- an item --------------------------------------------------------------------------- */

function ItemDrawer({ list, item, onClose, onSaved }: { list: GlobalList; item: GlobalListItem | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const declared = new Set(list.fields.map((f) => f.key))
  const [vals, setVals] = useState<Record<string, any>>(() => {
    const v: Record<string, any> = {}
    for (const f of list.fields) {
      const x = item?.value[f.key]
      v[f.key] = f.type === 'string[]' ? (Array.isArray(x) ? x.join('\n') : '') : f.type === 'boolean' ? !!x : x ?? ''
    }
    return v
  })
  const [langs, setLangs] = useState<{ locale: string; text: string }[]>(() =>
    Object.entries(item?.value ?? {}).filter(([k]) => !declared.has(k) && /^[a-z]{2}_[A-Z]{2}$/.test(k)).map(([locale, text]) => ({ locale, text: String(text) })))
  const [code, setCode] = useState(item?.code ?? '')
  const [position, setPosition] = useState(item ? String(item.position) : '')
  const [isDefault, setIsDefault] = useState(item?.isDefault ?? false)
  const [active, setActive] = useState(item?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  function value() {
    const v: Record<string, any> = {}
    for (const f of list.fields) {
      const x = vals[f.key]
      if (f.type === 'string[]') v[f.key] = String(x ?? '').split(/\n|,/).map((s) => s.trim()).filter(Boolean)
      else if (f.type === 'boolean') v[f.key] = !!x
      else if (f.type === 'number') { if (String(x).trim() !== '') v[f.key] = Number(x) }
      else if (String(x ?? '').trim() !== '') v[f.key] = String(x).trim()
    }
    for (const l of langs) if (l.locale && l.text.trim()) v[l.locale] = l.text.trim()
    return v
  }

  async function save(extra: Record<string, any> = {}, msg?: string) {
    setBusy(true); setErr('')
    try {
      const body: any = { value: value(), isDefault, active, ...extra }
      if (position.trim() !== '') body.position = Number(position)
      if (!list.codeField && code.trim() && (!item || code.trim() !== item.code)) body.code = code.trim()
      const r = item ? await gl.patchItem(list.key, item.id, body) : await gl.addItem(list.key, body)
      onSaved(msg ?? (item ? `${r.label} saved.` : `${r.label} added as ${r.code}.`))
    } catch (e: any) { setErr(errText(e)) } finally { setBusy(false) }
  }
  async function remove() {
    if (!item) return
    setBusy(true); setErr('')
    try { await gl.deleteItem(list.key, item.id); onSaved(`${item.label} deleted.`) } catch (e: any) { setErr(errText(e)) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => e.stopPropagation())} data-a11y-click="">
        <div className="drawer-h"><div className="t">{item ? item.label : `New ${list.name.replace(/s$/, '').toLowerCase()}`}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          <div className="field"><label>Code</label>
            {list.codeField
              ? <><input className="inp" value={item?.code ?? String(vals[list.codeField] ?? '').toUpperCase()} disabled />
                  <div className="hintxt">Follows {list.fields.find((f) => f.key === list.codeField)?.label ?? list.codeField}. Other records store this code.</div></>
              : <><input className="inp" value={code} onChange={(e) => setCode(e.target.value)} disabled={!!item && list.system} placeholder="Made from the name if left empty" />
                  <div className="hintxt">{item && list.system ? 'Fixed once made: other records store this code.' : 'Letters, digits, dot, dash and underscore. Other records store this code, so choose it once.'}</div></>}
          </div>

          {list.fields.map((f) => (
            <div className="field" key={f.key}>
              <label>{f.label}{f.required ? ' *' : ''}</label>
              {f.type === 'boolean' ? (
                <button type="button" role="switch" aria-checked={!!vals[f.key]} aria-label={f.label} className={`sw ${vals[f.key] ? '' : 'off'}`} style={{ border: 0 }}
                  onClick={() => setVals({ ...vals, [f.key]: !vals[f.key] })}><i /></button>
              ) : f.type === 'string[]' ? (
                <textarea className="inp" rows={5} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} placeholder="One per line" style={{ fontFamily: 'ui-monospace,monospace' }} />
              ) : (
                <input className="inp" inputMode={f.type === 'number' || f.sortAs === 'number' ? 'decimal' : undefined} value={vals[f.key]}
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
              )}
              {f.description && <div className="hintxt">{f.description}</div>}
            </div>
          ))}

          <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>Translations</span>
            <button type="button" className="btn ghost sm" onClick={() => setLangs([...langs, { locale: '', text: '' }])}>Add</button>
          </div>
          <div className="hintxt" style={{ marginTop: 0 }}>The label in other languages, by locale (fr_FR, zh_CN…). Readers ask with ?locale=.</div>
          {langs.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 6, marginTop: 6 }}>
              <input className="inp" placeholder="fr_FR" value={l.locale} aria-label="Locale"
                onChange={(e) => setLangs(langs.map((x, k) => k === i ? { ...x, locale: e.target.value } : x))} />
              <input className="inp" value={l.text} aria-label="Translated label" onChange={(e) => setLangs(langs.map((x, k) => k === i ? { ...x, text: e.target.value } : x))} />
              <button type="button" className="btn ghost sm" aria-label="Remove translation" onClick={() => setLangs(langs.filter((_, k) => k !== i))}>✕</button>
            </div>
          ))}

          <div className="sec-label">Use</div>
          <div className="toggle-row">
            <div><div className="tt">Default</div><div className="td">Pre-selected in pickers. One item per list.</div></div>
            <button type="button" role="switch" aria-checked={isDefault} aria-label="Default" className={`sw ${isDefault ? '' : 'off'}`} style={{ border: 0 }} onClick={() => setIsDefault(!isDefault)}><i /></button>
          </div>
          <div className="toggle-row">
            <div><div className="tt">In use</div><div className="td">Off retires it: no longer offered, still resolves for records that store it.</div></div>
            <button type="button" role="switch" aria-checked={active} aria-label="In use" className={`sw ${active ? '' : 'off'}`} style={{ border: 0 }} onClick={() => setActive(!active)}><i /></button>
          </div>
          <div className="field" style={{ marginTop: 10 }}><label>Position</label>
            <input className="inp" inputMode="numeric" value={position} placeholder="End of the list" onChange={(e) => setPosition(e.target.value.replace(/[^0-9]/g, ''))} style={{ maxWidth: 140 }} />
          </div>

          {err && <div style={{ marginTop: 12, whiteSpace: 'pre-line' }}><Notice kind="error" message={err} /></div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy} onClick={() => save()}>{item ? 'Save' : 'Add'}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <span style={{ flex: 1 }} />
            {item && !list.system && <button className="btn ghost" disabled={busy} onClick={remove}>Delete</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---- a list's fields and settings (or a new list) ---------------------------------------- */

function ListDrawer({ list, onClose, onSaved }: { list: GlobalList | null; onClose: () => void; onSaved: (l: GlobalList, msg: string) => void }) {
  const builtIn = new Set(list?.system ? list.fields.map((f) => f.key) : [])
  const [key, setKey] = useState(list?.key ?? '')
  const [name, setName] = useState(list?.name ?? '')
  const [description, setDescription] = useState(list?.description ?? '')
  const [visibility, setVisibility] = useState<Visibility>(list?.visibility ?? 'tenant')
  const [fields, setFields] = useState<FieldDef[]>(list?.fields ?? [{ key: 'name', label: 'Name', type: 'string', required: true }])
  const [labelField, setLabelField] = useState(list?.labelField ?? 'name')
  const [codeField, setCodeField] = useState(list?.codeField ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (i: number, patch: Partial<FieldDef>) => setFields(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)))

  async function save(extra: Record<string, any> = {}) {
    setBusy(true); setErr('')
    try {
      const clean = fields.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined && v !== false))) as unknown as FieldDef[]
      const body: any = { name, description: description || null, visibility, fields: clean, labelField, ...extra }
      const r = list ? await gl.patch(list.key, body) : await gl.create({ ...body, key, codeField: codeField || null })
      onSaved(r, list ? `${r.name} saved.` : `${r.name} created. Add its items, or import them.`)
    } catch (e: any) { setErr(errText(e)) } finally { setBusy(false) }
  }

  const textFields = fields.filter((f) => f.type === 'string' && f.key)
  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="">
      <div className="drawer" style={{ width: 'min(760px, 100vw)' }} {...pressable((e: any) => e.stopPropagation())} data-a11y-click="">
        <div className="drawer-h"><div className="t">{list ? `${list.name}: fields and settings` : 'New global list'}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <div className="field"><label>Key</label>
              <input className="inp" value={key} disabled={!!list} placeholder="e.g. languages" onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              <div className="hintxt">Its address: /api/global-lists/{key || 'key'}. Fixed once made.</div>
            </div>
            <div className="field"><label>Name</label><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          <div className="field"><label>Description</label><input className="inp" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it holds (shown to staff and in the API)" /></div>
          <div className="field"><label>Who can read it</label>
            <select className="inp" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              {(Object.keys(VIS_LABEL) as Visibility[]).map((v) => <option key={v} value={v}>{VIS_LABEL[v]}</option>)}
            </select>
            <div className="hintxt">Public lists can be cached by the CDN and used by players and the promo site without a key.</div>
          </div>

          <div className="sec-label" style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>Fields</span>
            <button type="button" className="btn ghost sm" onClick={() => setFields([...fields, { key: '', label: '', type: 'string' }])}>Add field</button>
          </div>
          <div className="hintxt" style={{ marginTop: 0 }}>A change is saved only when every existing item still fits it.{list?.system ? ' Built-in fields keep their key and type.' : ''}</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ minWidth: 640 }}>
              <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Required</th><th>Unique</th><th>Pattern</th><th></th></tr></thead>
              <tbody>
                {fields.map((f, i) => {
                  const locked = builtIn.has(f.key)
                  return (
                    <tr key={i}>
                      <td><input className="inp" value={f.key} disabled={locked} aria-label="Field key" style={{ minWidth: 100 }} onChange={(e) => set(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} /></td>
                      <td><input className="inp" value={f.label} aria-label="Field label" style={{ minWidth: 120 }} onChange={(e) => set(i, { label: e.target.value })} /></td>
                      <td><select className="inp" value={f.type} disabled={locked} aria-label="Field type" style={{ minWidth: 120 }} onChange={(e) => set(i, { type: e.target.value as FieldType })}>
                        {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.required} aria-label="Required" onChange={(e) => set(i, { required: e.target.checked })} /></td>
                      <td style={{ textAlign: 'center' }}><input type="checkbox" checked={!!f.unique} aria-label="Unique" disabled={f.type === 'boolean' || f.type === 'string[]'} onChange={(e) => set(i, { unique: e.target.checked })} /></td>
                      <td><input className="inp" value={f.pattern ?? ''} placeholder="optional regex" aria-label="Pattern" style={{ minWidth: 110, fontFamily: 'ui-monospace,monospace' }} disabled={f.type !== 'string' && f.type !== 'string[]'} onChange={(e) => set(i, { pattern: e.target.value })} /></td>
                      <td><button type="button" className="btn ghost sm" disabled={locked || fields.length === 1} aria-label="Remove field" onClick={() => setFields(fields.filter((_, k) => k !== i))}>✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 12 }}>
            <div className="field"><label>Label field</label>
              <select className="inp" value={labelField} onChange={(e) => setLabelField(e.target.value)}>
                {textFields.map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
              </select>
              <div className="hintxt">What pickers show. Must be a required text field.</div>
            </div>
            <div className="field"><label>Code follows</label>
              <select className="inp" value={codeField} disabled={!!list} onChange={(e) => setCodeField(e.target.value)}>
                <option value="">Nothing: set once per item</option>
                {textFields.map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
              </select>
              <div className="hintxt">e.g. Countries: ISO alpha-2. Must be required and unique.</div>
            </div>
          </div>

          {err && <div style={{ marginTop: 12, whiteSpace: 'pre-line' }}><Notice kind="error" message={err} /></div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy || !name.trim() || (!list && key.length < 2)} onClick={() => save()}>{list ? 'Save' : 'Create list'}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <span style={{ flex: 1 }} />
            {list && !list.system && <button className="btn ghost" disabled={busy} onClick={() => save({ archived: !list.archived })}>{list.archived ? 'Unarchive' : 'Archive'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---- import --------------------------------------------------------------------------- */

function ImportDrawer({ list, onClose, onDone }: { list: GlobalList; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [preview, setPreview] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)

  async function onFile(f?: File) {
    setErr(''); setPreview(null); setRows(null)
    if (!f) return
    setFileName(f.name)
    try {
      const data = JSON.parse(await f.text())
      // An export file ({ list, items }), { items }, or a bare array of items or values.
      const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
      if (!arr.length) throw new Error('No items found. Use a Volt export file, { "items": [...] } or an array.')
      setRows(arr.map((x) => (x && typeof x === 'object' && 'value' in x ? x : { value: x })))
    } catch (e: any) { setErr(`${f.name}: ${e.message}`) }
  }
  async function send(dryRun: boolean) {
    if (!rows) return
    setBusy(true); setErr('')
    try {
      const r = await gl.importItems(list.key, { items: rows, mode, dryRun })
      if (dryRun) setPreview(r)
      else onDone(`Imported: ${r.created} added, ${r.updated} updated, ${r.unchanged} unchanged${r.retired ? `, ${r.retired} retired` : ''}.`)
    } catch (e: any) { setErr(errText(e)); setPreview(null) } finally { setBusy(false) }
  }

  return (
    <div className="drawer-scrim" {...pressable(onClose)} data-a11y-click="">
      <div className="drawer" {...pressable((e: any) => e.stopPropagation())} data-a11y-click="">
        <div className="drawer-h"><div className="t">Import into {list.name}</div><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="drawer-b">
          <p className="hintxt" style={{ marginTop: 0 }}>A JSON file: a Volt export, <code>{'{ "items": [...] }'}</code>, or an array. Items are matched by code
            ({list.codeField ? `from ${list.codeField}` : 'given, or made from the label'}). Nothing is written unless every item fits.</p>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="btn ghost" onClick={() => { if (input.current) { input.current.value = ''; input.current.click() } }}>{fileName || 'Choose a file'}</button>
          {rows && <span className="gfx-meta" style={{ marginLeft: 10 }}>{rows.length} item{rows.length === 1 ? '' : 's'}</span>}

          <div className="sec-label">Mode</div>
          {(['merge', 'replace'] as const).map((m) => (
            <label key={m} className="toggle-row" style={{ cursor: 'pointer' }}>
              <div><div className="tt">{m === 'merge' ? 'Merge' : 'Replace'}</div>
                <div className="td">{m === 'merge' ? 'Add new codes and update matching ones. Everything else stays.' : 'As merge, and retire every item the file does not have (never deleted).'}</div></div>
              <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setPreview(null) }} />
            </label>
          ))}

          {preview && <div style={{ marginTop: 12 }}><Notice kind="ok" message={`Check passed: ${preview.created} to add, ${preview.updated} to update, ${preview.unchanged} unchanged${mode === 'replace' ? `, ${preview.retired} to retire` : ''}.`} /></div>}
          {err && <div style={{ marginTop: 12, whiteSpace: 'pre-line' }}><Notice kind="error" message={err} /></div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn ghost" disabled={!rows || busy} onClick={() => send(true)}>Check</button>
            <button className="btn primary" disabled={!preview || busy} onClick={() => send(false)}>Import</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}
