// ============================================================================
//  COLLECTIONS: the operator's own nested groupings of library assets
//  (volt-app modules/collections.ts). Shared by the Media Library's rail and
//  bulk bar, the Collections page, and the FAST builder's library.
//
//    BEATLINE                       a collection
//      Week 44: Monsoon Chill       a sub-collection (a week's playlist)
//      Week 45: Retro Malaysia
//
//  An asset can be in any number of collections; a collection keeps its own
//  order; deleting a collection never deletes media.
// ============================================================================
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest } from '../../api'
import { useNotify } from '../../notices'
import './collections.css'

export interface Collection {
  id: string; parentId: string | null; name: string; description: string | null; color: string | null; sortOrder: number
  itemCount: number; totalCount: number; durationMs: number; createdAt?: string; updatedAt?: string
}
export interface CollectionItem { id: string; title: string | null; durationMs: number; posterKey: string | null; series: string | null; genre: string | null; collectionId: string; position: number }
export interface TreeNode extends Collection { children: TreeNode[]; depth: number }

const J = (b: unknown) => ({ body: JSON.stringify(b) })
export const collectionsApi = {
  list: (): Promise<{ items: Collection[]; maxDepth: number }> => apiRequest('/collections'),
  get: (id: string): Promise<Collection & { path: { id: string; name: string }[]; children: { id: string; name: string; itemCount: number }[] }> => apiRequest(`/collections/${id}`),
  create: (b: { name: string; parentId?: string | null; description?: string | null; color?: string | null }): Promise<Collection> => apiRequest('/collections', { method: 'POST', ...J(b) }),
  update: (id: string, b: Partial<{ name: string; parentId: string | null; description: string | null; color: string | null; sortOrder: number }>): Promise<Collection> =>
    apiRequest(`/collections/${id}`, { method: 'PATCH', ...J(b) }),
  remove: (id: string): Promise<{ deleted: number; links: number }> => apiRequest(`/collections/${id}`, { method: 'DELETE' }),
  items: (id: string, deep = false): Promise<{ items: CollectionItem[] }> => apiRequest(`/collections/${id}/items${deep ? '?deep=true' : ''}`),
  add: (id: string, assetIds: string[]): Promise<{ added: number; already: number; notFound: number }> => apiRequest(`/collections/${id}/items`, { method: 'POST', ...J({ assetIds }) }),
  take: (id: string, assetIds: string[]): Promise<{ removed: number }> => apiRequest(`/collections/${id}/items/remove`, { method: 'POST', ...J({ assetIds }) }),
  order: (id: string, assetIds: string[]): Promise<{ ordered: number }> => apiRequest(`/collections/${id}/items/order`, { method: 'PUT', ...J({ assetIds }) }),
  memberships: (assetIds: string[]): Promise<{ memberships: Record<string, string[]> }> => apiRequest(`/collections/memberships?assetIds=${assetIds.join(',')}`),
}

/** Flat rows (parent before child, as the API orders them) -> a tree. */
export function buildTree(rows: Collection[]): TreeNode[] {
  const by = new Map<string, TreeNode>(rows.map((r) => [r.id, { ...r, children: [], depth: 0 }]))
  const roots: TreeNode[] = []
  for (const n of by.values()) {
    const p = n.parentId ? by.get(n.parentId) : null
    if (p) p.children.push(n); else roots.push(n)
  }
  const sort = (a: TreeNode[], d: number) => { a.sort((x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name)); a.forEach((n) => { n.depth = d; sort(n.children, d + 1) }) }
  sort(roots, 0)
  return roots
}
/** Depth-first, for selects and searching. */
export function flatten(tree: TreeNode[]): TreeNode[] { return tree.flatMap((n) => [n, ...flatten(n.children)]) }
/** "BEATLINE / Week 44" */
export function pathName(rows: Collection[], id: string | null | undefined): string {
  const by = new Map(rows.map((r) => [r.id, r])); const out: string[] = []
  let c = id ? by.get(id) : undefined; let guard = 0
  while (c && guard++ < 12) { out.unshift(c.name); c = c.parentId ? by.get(c.parentId) : undefined }
  return out.join(' / ')
}
export const fmtLength = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min` }

export function useCollections() {
  const [rows, setRows] = useState<Collection[] | null>(null)
  const [maxDepth, setMaxDepth] = useState(6)
  const [err, setErr] = useState('')
  const reload = useCallback(() => collectionsApi.list().then((r) => { setRows(r.items); setMaxDepth(r.maxDepth); setErr('') }).catch((e: any) => setErr(e.message)), [])
  useEffect(() => { reload() }, [reload])
  const tree = useMemo(() => buildTree(rows ?? []), [rows])
  return { rows, tree, maxDepth, err, reload }
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}><path d="m9 6 6 6-6 6" /></svg>
)
export const ColIcon = {
  folder: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  all: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  plus: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>,
  addTo: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></svg>,
  out: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 13h6" /></svg>,
  check: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="m5 12 5 5 9-10" /></svg>,
}

/**
 * The collection tree. Expandable; click a row to choose it. `extra` renders
 * per-row trailing content (counts by default). Remembers what is open.
 */
export function CollectionTree({ tree, selected, onSelect, extra, initiallyOpen, filter, compact }: {
  tree: TreeNode[]; selected?: string | null; onSelect: (n: TreeNode) => void
  extra?: (n: TreeNode) => ReactNode; initiallyOpen?: string[]; filter?: string; compact?: boolean
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen ?? []))
  // open the path to the selected collection
  useEffect(() => {
    if (!selected) return
    const parents = new Map(flatten(tree).map((n) => [n.id, n.parentId]))
    const add: string[] = []; let p = parents.get(selected) ?? null; let g = 0
    while (p && g++ < 12) { add.push(p); p = parents.get(p) ?? null }
    if (add.length) setOpen((o) => new Set([...o, ...add]))
  }, [selected, tree])
  const k = (filter ?? '').trim().toLowerCase()
  const matches = (n: TreeNode): boolean => !k || n.name.toLowerCase().includes(k) || n.children.some(matches)
  const row = (n: TreeNode): ReactNode => {
    if (!matches(n)) return null
    const isOpen = open.has(n.id) || (!!k && n.children.some(matches))
    return (
      <li key={n.id} role="treeitem" aria-expanded={n.children.length ? isOpen : undefined} aria-selected={selected === n.id}>
        <div className={`col-row${selected === n.id ? ' on' : ''}${compact ? ' compact' : ''}`} style={{ paddingLeft: 8 + n.depth * 16 }}
          onClick={() => onSelect(n)} tabIndex={0} onKeyDown={(e) => {
            if (e.key === 'Enter') onSelect(n)
            if (e.key === 'ArrowRight' && n.children.length) setOpen((o) => new Set([...o, n.id]))
            if (e.key === 'ArrowLeft') setOpen((o) => { const s = new Set(o); s.delete(n.id); return s })
          }}>
          <button type="button" className="col-tw" aria-label={isOpen ? 'Collapse' : 'Expand'} tabIndex={-1}
            style={{ visibility: n.children.length ? 'visible' : 'hidden' }}
            onClick={(e) => { e.stopPropagation(); setOpen((o) => { const s = new Set(o); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); return s }) }}>
            <Chevron open={isOpen} />
          </button>
          <span className="col-sw" style={n.color ? { color: n.color } : undefined}>{ColIcon.folder}</span>
          <span className="col-nm" title={n.description ?? n.name}>{n.name}</span>
          {extra ? extra(n) : <span className="col-ct" title={`${n.itemCount} here, ${n.totalCount} with sub-collections`}>{n.totalCount}</span>}
        </div>
        {n.children.length > 0 && isOpen && <ul role="group">{n.children.map(row)}</ul>}
      </li>
    )
  }
  return <ul className="col-tree" role="tree">{tree.map(row)}</ul>
}

/** A one-line "new collection" form (name, optional parent). */
export function NewCollection({ rows, parentId, onCreated, onCancel, maxDepth = 6 }: {
  rows: Collection[]; parentId?: string | null; onCreated: (c: Collection) => void; onCancel?: () => void; maxDepth?: number
}) {
  const notify = useNotify()
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string>(parentId ?? '')
  const [busy, setBusy] = useState(false)
  const flat = flatten(buildTree(rows)).filter((n) => n.depth < maxDepth - 1)
  const go = async () => {
    if (!name.trim()) return
    setBusy(true)
    try { onCreated(await collectionsApi.create({ name: name.trim(), parentId: parent || null })); setName('') }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't create it.", message: e.message }) } finally { setBusy(false) }
  }
  return (
    <div className="col-new">
      <input className="inp" autoFocus placeholder="Collection name, e.g. Week 44: Monsoon Chill" value={name} maxLength={120}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onCancel?.() }} aria-label="New collection name" />
      <select className="inp" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Inside">
        <option value="">At the top level</option>
        {flat.map((n) => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.depth ? '└ ' : ''}{n.name}</option>)}
      </select>
      <button className="btn primary" disabled={busy || !name.trim()} onClick={go}>{busy ? 'Creating…' : 'Create'}</button>
      {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
    </div>
  )
}

/**
 * ADD TO COLLECTION: pick a collection (or make one, nested anywhere) and add
 * the selected assets to it. Collections that already hold every selected
 * asset are ticked.
 */
export function AddToCollectionDialog({ assetIds, onClose, onDone }: { assetIds: string[]; onClose: () => void; onDone?: (c: Collection, added: number) => void }) {
  const notify = useNotify()
  const { rows, tree, maxDepth, reload } = useCollections()
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [members, setMembers] = useState<Record<string, string[]>>({})
  useEffect(() => { collectionsApi.memberships(assetIds.slice(0, 500)).then((r) => setMembers(r.memberships)).catch(() => {}) }, [assetIds.join(',')])
  const inAll = (cid: string) => assetIds.length > 0 && assetIds.every((a) => (members[a] ?? []).includes(cid))
  const inSome = (cid: string) => assetIds.filter((a) => (members[a] ?? []).includes(cid)).length
  const go = async () => {
    if (!pick) return
    setBusy(true)
    try {
      const r = await collectionsApi.add(pick, assetIds)
      const c = (rows ?? []).find((x) => x.id === pick)!
      notify({ kind: 'ok', title: `Added ${r.added} to ${pathName(rows ?? [], pick)}.`, message: r.already ? `${r.already} ${r.already === 1 ? 'was' : 'were'} already in it.` : undefined })
      onDone?.(c, r.added); onClose()
    } catch (e: any) { notify({ kind: 'error', title: "Couldn't add them.", message: e.message }) } finally { setBusy(false) }
  }
  const n = assetIds.length
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card col-dialog" role="dialog" aria-modal="true" aria-labelledby="atc-t" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="col-dialog-h">
          <h3 id="atc-t">Add {n} asset{n === 1 ? '' : 's'} to a collection</h3>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setMaking((m) => !m)}>{ColIcon.plus} New collection</button>
        </div>
        {making && rows && (
          <NewCollection rows={rows} parentId={pick} maxDepth={maxDepth} onCancel={() => setMaking(false)}
            onCreated={(c) => { setMaking(false); reload().then(() => setPick(c.id)) }} />
        )}
        <input className="inp" placeholder="Find a collection" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a collection" />
        <div className="col-dialog-list">
          {!rows ? <div className="loading">Loading…</div>
            : !rows.length ? <div className="hintxt" style={{ padding: 12 }}>No collections yet. Make the first one with <b>New collection</b>, for example <i>BEATLINE</i>, then sub-collections for each week inside it.</div>
            : <CollectionTree tree={tree} selected={pick} onSelect={(c) => setPick(c.id)} filter={q} initiallyOpen={tree.map((t) => t.id)}
              extra={(c) => inAll(c.id) ? <span className="col-in" title="Every selected asset is already in it">{ColIcon.check} in it</span>
                : inSome(c.id) ? <span className="col-ct" title="Some of the selection is already in it">{inSome(c.id)} of {n}</span>
                : <span className="col-ct">{c.itemCount}</span>} />}
        </div>
        <div className="modal-f">
          <span className="hintxt" style={{ margin: 0 }}>{pick ? <>Into <b>{pathName(rows ?? [], pick)}</b>. They are added at the end, in the order shown.</> : 'Choose a collection.'}</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!pick || busy || inAll(pick)} onClick={go}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}
