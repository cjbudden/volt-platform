// ============================================================================
//  INGEST RULES: what happens to a file when it arrives, as a ladder.
//
//    account default  <  content type  <  source or folder  <  item
//
//  Each rule is WHEN (what the file looks like) and THEN (what to do). An
//  absent THEN field inherits from the rung below; the baseline is shown so
//  nobody has to guess what "inherit" resolves to. Webhooks live here too,
//  since a rule names them.
// ============================================================================
import { useEffect, useState } from 'react'
import { api, type IngestRule, type IngestThen, type IngestWhen, type IngestWebhook, type ContentType, type Watchfolder } from '../api'
import { PageHead } from '../scaffold'
import { Notice, useNotify, usePageNotice } from '../notices'
import { FilenameRulesCard } from './FilenameRules'
import { useAccess } from '../access'

const RUNG_LABEL = { account: 'Account default', type: 'Content type', source: 'Source or folder' } as const
const NAMING = { honour: 'Keep the name (sanitised)', guid: 'GUID', guid_prefixed: 'GUID + name', template: 'Template' }
const STRUCTURE = { flat: 'Flat', honour: 'Keep the folder tree', minimal: 'kind / year / month', template: 'Template' }
const DUP = { ask: 'Ask', skip: 'Skip', replace: 'Replace', version: 'Keep both (version)', rename: 'Rename' }
const GATE = { none: 'Not required', before_ingest: 'Before ingest (bytes move first)', before_upload: 'Before upload' }
const TRANSFER = { auto: 'Auto (cloud to cloud when possible)', local: 'From this device', cloud: 'Cloud to cloud only' }
const FILENAME_META = { auto: 'applied when sure', suggest: 'suggested only', off: 'not read' }

// A RULE'S ONE-LINE SUMMARY IN WORDS, not its stored keys (build queue
// 1.14-G3a-2): the list used to read "when extensions=mov|mp4 then
// metadataRequired: before_ingest · autoUpload: false". A key this map does not
// know yet still shows, so a new field is never silently hidden.
const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
function whenWords(w: IngestWhen): string {
  const out: string[] = []
  for (const [k, v] of Object.entries(w) as [keyof IngestWhen, any][]) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue
    if (k === 'extensions') out.push(`the extension is ${v.join(' or ')}`)
    else if (k === 'kinds') out.push(`it is ${v.join(' or ')}`)
    else if (k === 'mimePrefixes') out.push(`the file type starts ${v.join(' or ')}`)
    else if (k === 'namePattern') out.push(`the name matches ${v.pattern}`)
    else if (k === 'pathPrefix') out.push(`it is in ${v}`)
    else if (k === 'minBytes') out.push(`it is at least ${mb(v)}`)
    else if (k === 'maxBytes') out.push(`it is at most ${mb(v)}`)
    else if (k === 'minDurationSec') out.push(`it runs at least ${v} s`)
    else if (k === 'maxDurationSec') out.push(`it runs at most ${v} s`)
    else if (k === 'minHeight') out.push(`it is at least ${v}p`)
    else if (k === 'hasTags') out.push(v ? 'it has tags' : 'it has no tags')
    else out.push(`${k} ${Array.isArray(v) ? v.join(' or ') : String(v)}`)
  }
  return out.join(' and ')
}
function thenWords(t: IngestThen, typeName: (id: string) => string = (id) => id): string {
  const out: string[] = []
  for (const [k, v] of Object.entries(t) as [keyof IngestThen, any][]) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue
    if (k === 'contentTypeId') out.push(`type ${typeName(v)}`)
    else if (k === 'targetKind') out.push(`filed as ${v}`)
    else if (k === 'naming') out.push(`name: ${(NAMING as any)[v] ?? v}`)
    else if (k === 'structure') out.push(`folders: ${(STRUCTURE as any)[v] ?? v}`)
    else if (k === 'nameTemplate') out.push(`name template ${v}`)
    else if (k === 'pathTemplate') out.push(`folder template ${v}`)
    else if (k === 'lowercase') out.push(v ? 'lower case names' : 'names keep their case')
    else if (k === 'duplicate') out.push(`duplicates: ${(DUP as any)[v] ?? v}`)
    else if (k === 'nameCheck') out.push(v ? 'name check on' : 'name check off')
    else if (k === 'transfer') out.push(`transfer: ${(TRANSFER as any)[v] ?? v}`)
    else if (k === 'metadataRequired') out.push(`metadata: ${(GATE as any)[v] ?? v}`)
    else if (k === 'autoUpload') out.push(v ? 'uploads start on their own' : 'uploads wait for Start')
    else if (k === 'sidecar') out.push(v === 'none' ? 'no sidecar file' : `${String(v).toUpperCase()} sidecar file`)
    else if (k === 'webhooks') out.push(`${v.length} webhook${v.length === 1 ? '' : 's'}`)
    else if (k === 'ladderGroupId') out.push('its own encoding ladder')
    else if (k === 'reject') out.push(`refused: ${v}`)
    else if (k === 'filenameMetadata') out.push(`file name ${(FILENAME_META as any)[v] ?? v}`)
    else out.push(`${k}: ${Array.isArray(v) ? v.length : String(v)}`)
  }
  return out.join(' · ')
}

function Sel<T extends string>({ label, value, options, onChange, inherit }: { label: string; value: T | undefined; options: Record<string, string>; onChange: (v: T | undefined) => void; inherit: string }) {
  return (
    <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <select value={value ?? ''} onChange={e => onChange((e.target.value || undefined) as T | undefined)}>
        <option value="">Inherit ({inherit})</option>
        {Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  )
}

function RuleForm({ rule, types, folders, hooks, baseline, onSaved, onCancel }: {
  rule: Partial<IngestRule>; types: ContentType[]; folders: Watchfolder[]; hooks: IngestWebhook[]; baseline: Required<IngestThen> | null
  onSaved: () => void; onCancel: () => void
}) {
  const [r, setR] = useState<Partial<IngestRule>>({ then: {}, when: null, ...rule })
  const [err, setErr] = useState('')
  const then = r.then ?? {}
  const when = r.when ?? {}
  const setThen = (patch: Partial<IngestThen>) => setR({ ...r, then: { ...then, ...patch } })
  const setWhen = (patch: Partial<IngestWhen>) => { const w = { ...when, ...patch }; for (const k of Object.keys(w)) if ((w as any)[k] === undefined || (w as any)[k] === '') delete (w as any)[k]; setR({ ...r, when: Object.keys(w).length ? w : null }) }
  const inh = (k: keyof IngestThen) => baseline ? String(baseline[k] ?? 'none') : 'baseline'
  async function save() {
    setErr('')
    try {
      const body = { rung: r.rung ?? 'account', scopeId: r.rung === 'account' ? null : (r.scopeId ?? null), ordinal: r.ordinal ?? 0, name: r.name || 'Untitled rule', enabled: r.enabled ?? true, when: r.when ?? null, then, metadataDefaults: r.metadataDefaults ?? {} }
      if (r.id) await api.updateIngestRule(r.id, body as any); else await api.createIngestRule(body as any)
      onSaved()
    } catch (e: any) { setErr(e.message) }
  }
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Name</span><input value={r.name ?? ''} onChange={e => setR({ ...r, name: e.target.value })} /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Rung</span>
          <select value={r.rung ?? 'account'} onChange={e => setR({ ...r, rung: e.target.value as any, scopeId: null })}>{Object.entries(RUNG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {r.rung === 'type' && <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Content type</span>
          <select value={r.scopeId ?? ''} onChange={e => setR({ ...r, scopeId: e.target.value || null })}><option value="">Any type</option>{types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
        {r.rung === 'source' && <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Source</span>
          <select value={r.scopeId ?? ''} onChange={e => setR({ ...r, scopeId: e.target.value || null })}>
            <option value="">Any source</option><option value="panel">Console panel</option><option value="api">API and tus clients</option><option value="tus">tus (no source named)</option><option value="url">Links</option><option value="dropbox">Dropbox</option><option value="onedrive">OneDrive</option><option value="gdrive">Google Drive</option><option value="aspera">Aspera</option><option value="masv">MASV</option><option value="signiant">Signiant</option><option value="agent">Desktop agent</option>
            {folders.map(f => <option key={f.id} value={f.id}>Folder: {f.name}</option>)}
          </select></label>}
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Order (lower wins first)</span><input type="number" value={r.ordinal ?? 0} onChange={e => setR({ ...r, ordinal: Number(e.target.value) })} /></label>
      </div>

      <div className="sec-label">When (all that are set must hold; leave empty to always match)</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Extensions (comma separated)</span><input value={(when.extensions ?? []).join(', ')} onChange={e => setWhen({ extensions: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} placeholder="mxf, mov, mp4" /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Kind</span>
          <select value={(when.kinds ?? [])[0] ?? ''} onChange={e => setWhen({ kinds: e.target.value ? [e.target.value as any] : undefined })}><option value="">Any</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Image</option><option value="other">Other</option></select></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Name pattern (glob)</span><input value={when.namePattern?.pattern ?? ''} onChange={e => setWhen({ namePattern: e.target.value ? { type: 'glob', pattern: e.target.value } : undefined })} placeholder="slate_*.png" /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Path starts with</span><input value={when.pathPrefix ?? ''} onChange={e => setWhen({ pathPrefix: e.target.value || undefined })} placeholder="Shoots/Day 1" /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Min duration (minutes)</span><input type="number" value={when.minDurationSec != null ? when.minDurationSec / 60 : ''} onChange={e => setWhen({ minDurationSec: e.target.value ? Number(e.target.value) * 60 : undefined })} /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Min size (MB)</span><input type="number" value={when.minBytes != null ? when.minBytes / 1e6 : ''} onChange={e => setWhen({ minBytes: e.target.value ? Number(e.target.value) * 1e6 : undefined })} /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Min height (px)</span><input type="number" value={when.minHeight ?? ''} onChange={e => setWhen({ minHeight: e.target.value ? Number(e.target.value) : undefined })} placeholder="1080" /></label>
      </div>

      <div className="sec-label">Then</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Content type</span>
          <select value={then.contentTypeId ?? ''} onChange={e => setThen({ contentTypeId: e.target.value || undefined })}><option value="">Inherit</option>{types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <Sel label="Naming" value={then.naming} options={NAMING} onChange={v => setThen({ naming: v })} inherit={inh('naming')} />
        <Sel label="Folder structure" value={then.structure} options={STRUCTURE} onChange={v => setThen({ structure: v })} inherit={inh('structure')} />
        {then.naming === 'template' && <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Name template</span><input value={then.nameTemplate ?? ''} onChange={e => setThen({ nameTemplate: e.target.value || null })} placeholder="{type}_{name}.{ext}" /></label>}
        {then.structure === 'template' && <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Path template</span><input value={then.pathTemplate ?? ''} onChange={e => setThen({ pathTemplate: e.target.value || null })} placeholder="{kind}/{yyyy}/{mm}/{path}" /></label>}
        <Sel label="Duplicate" value={then.duplicate} options={DUP} onChange={v => setThen({ duplicate: v })} inherit={inh('duplicate')} />
        <Sel label="Metadata required" value={then.metadataRequired} options={GATE} onChange={v => setThen({ metadataRequired: v })} inherit={inh('metadataRequired')} />
        <Sel label="Transfer" value={then.transfer} options={TRANSFER} onChange={v => setThen({ transfer: v })} inherit={inh('transfer')} />
        <Sel label="Sidecar" value={then.sidecar} options={{ none: 'None', json: 'JSON beside the object', xml: 'XML beside the object' }} onChange={v => setThen({ sidecar: v })} inherit={inh('sidecar')} />
        <Sel label="Read the file name" value={then.filenameMetadata} options={{ auto: 'Apply what is clear', suggest: 'Only suggest', off: 'Off' }} onChange={v => setThen({ filenameMetadata: v })} inherit={baseline?.filenameMetadata ? ({ auto: 'apply what is clear', suggest: 'only suggest', off: 'off' } as any)[baseline.filenameMetadata] : 'apply what is clear'} />
        <Sel label="Auto upload" value={then.autoUpload === undefined ? undefined : String(then.autoUpload)} options={{ true: 'On', false: 'Off' }} onChange={v => setThen({ autoUpload: v === undefined ? undefined : v === 'true' })} inherit={inh('autoUpload')} />
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Webhooks</span>
          <select multiple value={then.webhooks ?? []} onChange={e => setThen({ webhooks: [...e.target.selectedOptions].map(o => o.value) })} style={{ minHeight: 60 }}>{hooks.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xs)' }}><span style={{ color: 'var(--muted)' }}>Refuse with reason (instead of ingesting)</span><input value={then.reject ?? ''} onChange={e => setThen({ reject: e.target.value || null })} placeholder="project files are never wanted here" /></label>
      </div>
      {err && <Notice kind="error" variant="compact" message={err} />}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={save}>Save rule</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function IngestRulesPage() {
  const [rules, setRules] = useState<IngestRule[]>([])
  const [types, setTypes] = useState<ContentType[]>([])
  const [folders, setFolders] = useState<Watchfolder[]>([])
  const [hooks, setHooks] = useState<IngestWebhook[]>([])
  const [baseline, setBaseline] = useState<Required<IngestThen> | null>(null)
  const [editing, setEditing] = useState<Partial<IngestRule> | null>(null)
  const [newHook, setNewHook] = useState({ name: '', url: '' })
  const [shownSecret, setShownSecret] = useState<string | null>(null)
  const { seesServerSetup } = useAccess()
  const [providers, setProviders] = useState<{ linked: { id: string; provider: string; label: string }[]; available: { provider: string; configured: boolean }[] } | null>(null)
  const [accel, setAccel] = useState<{ provider: 'aspera' | 'masv' | 'signiant'; label: string; config: string }>({ provider: 'aspera', label: '', config: '{"nodeUrl":"https://node.example.com:9092","user":"","password":"","destinationRoot":"/volt/inbox"}' })
  const [err, setErr] = useState('')
  const notify = useNotify()
  const fail = (e: any) => notify({ kind: 'error', message: e.message })

  async function load() {
    try {
      const [r, t, f, h, b] = await Promise.all([api.ingestRules(), api.contentTypes('vod'), api.watchfolders().catch(() => [] as Watchfolder[]), api.ingestWebhooks(), api.ingestBaseline()])
      setRules(r); setTypes(t); setFolders(f); setHooks(h); setBaseline(b.baseline)
      api.ingestProviders().then(setProviders).catch(() => {})
      setErr('')
    } catch (e: any) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])
  useEffect(() => { const h = (e: MessageEvent) => { if (e.data?.voltProviderLinked) load() }; window.addEventListener('message', h); return () => window.removeEventListener('message', h) }, [])

  async function linkProvider(provider: string) {
    try { const { url } = await api.ingestProviderAuthorize(provider); window.open(url, 'volt-link', 'width=560,height=720') } catch (e: any) { fail(e) }
  }
  usePageNotice('load', err ? { kind: 'error', title: "Couldn't load ingest rules.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  const scopeName = (r: IngestRule) => r.rung === 'account' ? '' : r.rung === 'type' ? (types.find(t => t.id === r.scopeId)?.name ?? (r.scopeId ? r.scopeId : 'any type')) : (folders.find(f => f.id === r.scopeId)?.name ?? (r.scopeId ?? 'any source'))
  const thenSummary = (t: IngestThen) => thenWords(t, (id) => types.find(x => x.id === id)?.name ?? 'a content type') || 'inherits everything'

  return (
    <>
      <PageHead title="Ingest Rules" sub="What happens to a file when it arrives, from any door: the name it gets, where it is filed, what counts as a duplicate, whether metadata is required first, where the sidecar and webhooks go. The account default applies to everything; a content type or a source can override any part of it." action={<button className="btn primary" onClick={() => setEditing({ rung: 'account', then: {} })}>Add rule</button>} />
      {baseline && (
        <div className="card" style={{ padding: 14, marginBottom: 14, fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
          <div className="sec-label">Platform baseline (what "inherit" means when nothing else says)</div>
          naming {NAMING[baseline.naming]} · structure {STRUCTURE[baseline.structure]} · duplicate {DUP[baseline.duplicate]} · metadata {GATE[baseline.metadataRequired]} · transfer {TRANSFER[baseline.transfer]} · {thenWords({ sidecar: baseline.sidecar, autoUpload: baseline.autoUpload })}
        </div>
      )}
      {editing && <div style={{ marginBottom: 14 }}><RuleForm rule={editing} types={types} folders={folders} hooks={hooks} baseline={baseline} onSaved={() => { setEditing(null); load() }} onCancel={() => setEditing(null)} /></div>}
      {(['account', 'type', 'source'] as const).map(rung => (
        <div key={rung} className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="sec-label">{RUNG_LABEL[rung]}</div>
          {rules.filter(r => r.rung === rung).length === 0 && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>No rules on this rung.</div>}
          {rules.filter(r => r.rung === rung).map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)', opacity: r.enabled ? 1 : .5 }}>
              <span style={{ fontFamily: 'var(--mono, monospace)', color: 'var(--muted)', width: 28 }}>{r.ordinal}</span>
              <span style={{ minWidth: 160 }}><strong>{r.name}</strong>{scopeName(r) ? <span style={{ color: 'var(--muted)' }}> · {scopeName(r)}</span> : null}</span>
              <span style={{ flex: 1, color: 'var(--muted)', fontSize: 'var(--fs-xs)' }}>{r.when && whenWords(r.when) ? `when ${whenWords(r.when)}: ` : 'always: '}{thenSummary(r.then)}</span>
              <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => api.updateIngestRule(r.id, { enabled: !r.enabled }).then(load)}>{r.enabled ? 'Disable' : 'Enable'}</button>
              <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => setEditing(r)}>Edit</button>
              <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) api.deleteIngestRule(r.id).then(load) }}>Delete</button>
            </div>
          ))}
        </div>
      ))}

      <FilenameRulesCard />

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="sec-label">Linked cloud accounts (cloud to cloud transfer, and "this file is already in Dropbox")</div>
        {providers?.linked.map(l => (
          <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
            <span style={{ minWidth: 100 }}><strong>{l.provider}</strong></span><span style={{ flex: 1, color: 'var(--muted)' }}>{l.label}</span>
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => api.deleteIngestProvider(l.id).then(() => api.ingestProviders().then(setProviders))}>Unlink</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {providers?.available.map(a => (
            <button key={a.provider} className="btn" disabled={!a.configured} title={a.configured ? '' : seesServerSetup ? 'Set the client id and secret for this provider on the server first' : 'Not set up on this Volt service yet. Your Volt provider sets it up.'} onClick={() => linkProvider(a.provider)}>Link {a.provider === 'gdrive' ? 'Google Drive' : a.provider === 'onedrive' ? 'OneDrive' : 'Dropbox'}</button>
          ))}
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>Google Drive links with the picker scope only: files you pick, never a search of your Drive.</span>
        </div>
        <div className="sec-label" style={{ marginTop: 12 }}>Accelerated transfer providers</div>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'start' }}>
          <select value={accel.provider} onChange={e => setAccel({ ...accel, provider: e.target.value as any, config: e.target.value === 'aspera' ? '{"nodeUrl":"https://node.example.com:9092","user":"","password":"","destinationRoot":"/volt/inbox"}' : e.target.value === 'masv' ? '{"apiKey":"","teamId":"","portalSubdomain":""}' : '{"clientId":"","clientSecret":"","portalUrl":""}' })}>
            <option value="aspera">IBM Aspera</option><option value="masv">MASV</option><option value="signiant">Signiant</option>
          </select>
          <div style={{ display: 'grid', gap: 6 }}>
            <input placeholder="Label (e.g. Sydney Aspera node)" value={accel.label} onChange={e => setAccel({ ...accel, label: e.target.value })} />
            <textarea rows={3} value={accel.config} onChange={e => setAccel({ ...accel, config: e.target.value })} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 'var(--fs-xs)' }} />
            <button className="btn" style={{ justifySelf: 'start' }} disabled={!accel.label} onClick={async () => { try { await api.addIngestProvider({ provider: accel.provider, label: accel.label, config: JSON.parse(accel.config) }); setAccel({ ...accel, label: '' }); api.ingestProviders().then(setProviders) } catch (e: any) { fail(e) } }}>Add provider</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 14 }}>
        <div className="sec-label">Webhooks (signed POST of the ingest payload)</div>
        {hooks.map(h => (
          <div key={h.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
            <span style={{ minWidth: 140 }}><strong>{h.name}</strong></span>
            <span style={{ flex: 1, color: 'var(--muted)', fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.url} · {h.events.join(', ')}{h.lastAt ? ` · last ${h.lastStatus ?? 'error'} ${new Date(h.lastAt).toLocaleString()}` : ''}{h.lastError ? ` · ${h.lastError}` : ''}</span>
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => api.updateIngestWebhook(h.id, { enabled: !h.enabled }).then(load)}>{h.enabled ? 'Disable' : 'Enable'}</button>
            <button className="btn ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => api.deleteIngestWebhook(h.id).then(load)}>Delete</button>
          </div>
        ))}
        {shownSecret && <div className="card" style={{ padding: 10, margin: '8px 0', fontSize: 'var(--fs-xs)' }}>Signing secret (shown once): <code>{shownSecret}</code>. Verify <code>x-volt-signature: t=&lt;ts&gt;,v1=HMAC-SHA256(secret, ts + "." + body)</code>.</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input placeholder="Name" value={newHook.name} onChange={e => setNewHook({ ...newHook, name: e.target.value })} />
          <input placeholder="https://your-system/ingest" value={newHook.url} onChange={e => setNewHook({ ...newHook, url: e.target.value })} style={{ flex: 1, minWidth: 220 }} />
          <button className="btn" disabled={!newHook.name || !newHook.url} onClick={async () => { try { const h = await api.createIngestWebhook(newHook); setShownSecret(h.secret ?? null); setNewHook({ name: '', url: '' }); load() } catch (e: any) { fail(e) } }}>Add webhook</button>
        </div>
      </div>
    </>
  )
}
