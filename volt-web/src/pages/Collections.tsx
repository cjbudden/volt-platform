// ============================================================================
//  COLLECTIONS: make, nest, rename, move, colour, order and remove the
//  operator's collections (volt-app modules/collections.ts).
//
//    [tree]                  [the chosen collection]
//    BEATLINE        12       BEATLINE / Week 44: Monsoon Chill
//      Week 44        9       name, description, colour, inside
//      Week 45        3       sub-collections
//    GOLDFRAME        4       its assets, in order: move up / down, take out
//
//  /collections/<id> opens one. Assets are added from the Media Library
//  (select, then Add to collection); this page orders and prunes them.
// ============================================================================
import { useEffect, useMemo, useState } from 'react'
import { navigate, useRoute } from '../router'
import { Notice, useNotify } from '../notices'
import { ConfirmDialog } from '../listActions'
import {
  CollectionTree, ColIcon, NewCollection, buildTree, collectionsApi, flatten, fmtLength, pathName, useCollections,
  type CollectionItem, type TreeNode,
} from './vod/collections'
import './vod/collections.css'

const SWATCHES = ['#ff4d6d', '#ffb703', '#2ec4b6', '#b8a1ff', '#3f7bff', '#d4a64a', '#8bd450', '#f78fb3']
const durOf = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export default function CollectionsPage() {
  useRoute()
  const notify = useNotify()
  const { rows, tree, maxDepth, err, reload } = useCollections()
  const sel = window.location.pathname.split('/')[2] || null
  const choose = (id: string | null) => navigate(id ? `/collections/${id}` : '/collections')
  const [q, setQ] = useState('')
  const [making, setMaking] = useState<null | { parentId: string | null }>(null)
  const node = useMemo(() => flatten(tree).find((n) => n.id === sel) ?? null, [tree, sel])

  if (err && !rows) return <Notice kind="error" title="Couldn't load collections." message={err} />
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Collections</h1>
          <p>Your own groupings of library media, nested as deep as you need: a collection per channel or show, with sub-collections for each week's playlist. Media can be in any number of collections, and removing a collection never removes media.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={() => navigate('/vod')}>Media Library</button>
        <button className="btn primary" onClick={() => setMaking({ parentId: null })}>{ColIcon.plus} New collection</button>
      </div>
      {making && rows && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <NewCollection rows={rows} parentId={making.parentId} maxDepth={maxDepth} onCancel={() => setMaking(null)}
            onCreated={(c) => { setMaking(null); reload(); choose(c.id); notify({ kind: 'ok', message: `Made "${c.name}". Add media from the Media Library: select, then Add to collection.` }) }} />
        </div>
      )}
      <div className="colp">
        <div className="card colp-tree">
          <div style={{ padding: '12px 12px 6px' }}><input className="inp" placeholder="Find a collection" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a collection" /></div>
          {!rows ? <div className="loading">Loading…</div>
            : !rows.length ? <div className="hintxt" style={{ padding: 14 }}>No collections yet. Make one with <b>New collection</b>, for example <i>BEATLINE</i>, then a sub-collection inside it for each week.</div>
            : <CollectionTree tree={tree} selected={sel} onSelect={(n) => choose(n.id)} filter={q} initiallyOpen={tree.map((t) => t.id)}
              extra={(n) => <span className="col-ct" title={`${n.itemCount} here, ${n.totalCount} with sub-collections`}>{n.itemCount}{n.totalCount !== n.itemCount ? ` · ${n.totalCount}` : ''}</span>} />}
        </div>
        {node && rows ? <Detail key={node.id} node={node} all={rows} maxDepth={maxDepth} onChanged={reload} onChoose={choose}
          onNewSub={() => setMaking({ parentId: node.id })} />
          : <div className="card"><div className="card-b" style={{ color: 'var(--muted)' }}>
            {rows?.length ? 'Choose a collection to name it, nest it, colour it, and order or prune its media.' : 'Collections you make show here.'}
            <ul style={{ margin: '12px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li><b>Add media:</b> Media Library, select in the list or grid, then <b>Add to collection</b>.</li>
              <li><b>Browse:</b> the Collections rail beside the Media Library filters the library to a collection, with or without its sub-collections, and every other filter still works inside it.</li>
              <li><b>Program:</b> in a FAST channel's run order, the library can add a whole collection, in its order.</li>
            </ul>
          </div></div>}
      </div>
    </>
  )
}

function Detail({ node, all, maxDepth, onChanged, onChoose, onNewSub }: {
  node: TreeNode; all: ReturnType<typeof useCollections>['rows'] & {}; maxDepth: number
  onChanged: () => void; onChoose: (id: string | null) => void; onNewSub: () => void
}) {
  const notify = useNotify()
  const [name, setName] = useState(node.name)
  const [desc, setDesc] = useState(node.description ?? '')
  const [items, setItems] = useState<CollectionItem[] | null>(null)
  const [deep, setDeep] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const loadItems = () => collectionsApi.items(node.id, deep).then((r) => setItems(r.items)).catch((e: any) => notify({ kind: 'error', message: e.message }))
  useEffect(() => { loadItems() }, [node.id, deep])
  const save = async (b: Parameters<typeof collectionsApi.update>[1], ok?: string) => {
    try { await collectionsApi.update(node.id, b); onChanged(); if (ok) notify({ kind: 'ok', message: ok }) }
    catch (e: any) { notify({ kind: 'error', title: "Couldn't save.", message: e.message }) }
  }
  // where it may move: not into itself or anything under it, not too deep
  const below = new Set(flatten([node]).map((n) => n.id))
  const height = Math.max(...flatten([node]).map((n) => n.depth - node.depth)) + 1
  const targets = flatten(buildTree(all)).filter((n) => !below.has(n.id) && n.depth + 1 + height <= maxDepth)
  const subs = node.children
  const move = async (i: number, d: number) => {
    if (!items) return
    const next = [...items]; const [it] = next.splice(i, 1); next.splice(i + d, 0, it)
    setItems(next)
    try { await collectionsApi.order(node.id, next.map((x) => x.id)) } catch (e: any) { notify({ kind: 'error', message: e.message }); loadItems() }
  }
  const take = async (it: CollectionItem) => {
    try { await collectionsApi.take(it.collectionId, [it.id]); loadItems(); onChanged() } catch (e: any) { notify({ kind: 'error', message: e.message }) }
  }
  const total = (items ?? []).reduce((s, x) => s + x.durationMs, 0)
  const path = pathName(all, node.id).split(' / ')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {confirm && (
        <ConfirmDialog title={`Remove "${node.name}"?`} danger confirmLabel="Remove collection" typeToConfirm={node.name}
          body={<>This removes the collection{subs.length ? <> and its <b>{flatten(subs).length} sub-collection{flatten(subs).length === 1 ? '' : 's'}</b></> : null}. The <b>{node.totalCount}</b> asset{node.totalCount === 1 ? '' : 's'} in {node.totalCount === 1 ? 'it stays' : 'them stay'} in the Media Library and in any other collections.</>}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false)
            try { const r = await collectionsApi.remove(node.id); onChanged(); onChoose(node.parentId); notify({ kind: 'ok', message: `Removed ${r.deleted} collection${r.deleted === 1 ? '' : 's'}. No media was removed.` }) }
            catch (e: any) { notify({ kind: 'error', message: e.message }) }
          }} />
      )}
      <div className="card">
        <div className="card-h" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            {path.length > 1 && <div className="colp-crumb">{path.slice(0, -1).map((p, i) => {
              let c = all.find((x) => x.id === node.id); for (let k = path.length - 1; k > i && c; k--) c = all.find((x) => x.id === c!.parentId)
              return <span key={i}><button onClick={() => onChoose(c?.id ?? null)}>{p}</button> /</span>
            })}</div>}
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ color: node.color ?? 'var(--muted)', display: 'inline-flex' }}>{ColIcon.folder}</span>{node.name}</h3>
          </div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => navigate(`/vod?col=${node.id}`)}>Open in Media Library</button>
          {node.depth + 1 < maxDepth && <button className="btn ghost sm" onClick={onNewSub}>{ColIcon.plus} Sub-collection</button>}
          <button className="btn ghost sm danger" onClick={() => setConfirm(true)}>Remove</button>
        </div>
        <div className="card-b colp-kv">
          <label htmlFor="cn">Name</label>
          <input id="cn" className="inp" value={name} maxLength={120} onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name.trim() !== node.name) save({ name: name.trim() }); else setName(node.name) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
          <label htmlFor="cd">Description</label>
          <input id="cd" className="inp" value={desc} maxLength={2000} placeholder="What it is for, e.g. the theme of the week"
            onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc !== (node.description ?? '')) save({ description: desc || null }) }} />
          <span>Colour</span>
          <div className="colp-sw" role="radiogroup" aria-label="Colour">
            <button type="button" className={`none${!node.color ? ' on' : ''}`} role="radio" aria-checked={!node.color} aria-label="No colour" onClick={() => save({ color: null })}>×</button>
            {SWATCHES.map((c) => <button key={c} type="button" className={node.color === c ? 'on' : ''} role="radio" aria-checked={node.color === c} aria-label={c} style={{ background: c }} onClick={() => save({ color: c })} />)}
          </div>
          <label htmlFor="cp">Inside</label>
          <select id="cp" className="inp" value={node.parentId ?? ''} onChange={(e) => save({ parentId: e.target.value || null }, 'Moved.')}>
            <option value="">At the top level</option>
            {targets.map((n) => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.depth ? '└ ' : ''}{n.name}</option>)}
          </select>
        </div>
        {subs.length > 0 && (
          <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="hintxt" style={{ marginTop: 0, marginBottom: 8 }}>Sub-collections</div>
            <div className="colp-subs">{subs.map((c) => (
              <button key={c.id} className="fast-pill" style={{ cursor: 'pointer', border: 0 }} onClick={() => onChoose(c.id)}>
                <span className="t" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ color: c.color ?? 'var(--muted)', display: 'inline-flex' }}>{ColIcon.folder}</span>{c.name}</span><span className="d">{c.totalCount}</span>
              </button>))}</div>
          </div>
        )}
      </div>

      <div className="card colp-items">
        <div className="card-h"><h3>Media</h3>
          <span className="sub">{items ? `${items.length} item${items.length === 1 ? '' : 's'} · ${fmtLength(total)}` : ''}{deep ? ' · with sub-collections' : ' · in collection order'}</span>
          <span className="spacer" />
          {subs.length > 0 && <label className="fast-mini"><input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> Include sub-collections</label>}
        </div>
        {!items ? <div className="card-b loading">Loading…</div>
          : !items.length ? <div className="card-b" style={{ color: 'var(--muted)' }}>Nothing in it yet. In the <a href={`/vod`} onClick={(e) => { e.preventDefault(); navigate('/vod') }}>Media Library</a>, select media in the list or grid and use <b>Add to collection</b>.</div>
          : items.map((it, i) => {
            const from = it.collectionId !== node.id ? all.find((c) => c.id === it.collectionId)?.name : null
            return (
              <div key={`${it.collectionId}:${it.id}`} className="it">
                <span className="n">{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="t"><a href={`/vod?asset=${it.id}`} onClick={(e) => { e.preventDefault(); navigate(`/vod?asset=${it.id}`) }} style={{ color: 'inherit', textDecoration: 'none' }}>{it.title || 'Untitled'}</a></div>
                  {(it.series || it.genre || from) && <div className="m">{[it.series, it.genre, from ? `in ${from}` : null].filter(Boolean).join(' · ')}</div>}
                </div>
                <span className="d">{durOf(it.durationMs)}</span>
                <div className="ctl">
                  {!deep && <>
                    <button className="fast-ico" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 15 6-6 6 6" /></svg></button>
                    <button className="fast-ico" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg></button>
                  </>}
                  <button className="fast-ico" aria-label={`Take ${it.title || 'it'} out of the collection`} title={from ? `Take it out of ${from}` : 'Take it out (it stays in the library)'} onClick={() => take(it)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}
