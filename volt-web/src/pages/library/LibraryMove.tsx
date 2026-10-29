// Image Library: moving images to a folder, and removing an empty folder
// (docs/IMAGES.md section 18). Moves keep every use of an image working:
// references are rewritten and the old address forwards to the new one.
import { useEffect, useMemo, useState } from 'react'
import { apiRequest, thumbUrl, type MediaFile } from '../../api'
import { ImagePicker } from '../../ImagePicker'
import './libraryMove.css'

export interface MoveOutcome {
  moved: { id: string; from: string; to: string }[]
  skipped: { id: string; name: string; reason: string }[]
  references: Record<string, number>
}

const J = (method: string, b: unknown): RequestInit => ({ method, body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

/** Move the given images: pick a folder (or type a new one). */
export function MoveDialog({ ids, names, from, onClose, onMoved }: {
  ids: string[]; names: string[]; from: string; onClose: () => void; onMoved: (r: MoveOutcome, folder: string) => void
}) {
  const [all, setAll] = useState<string[] | null>(null)
  const [filter, setFilter] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [fresh, setFresh] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { apiRequest('/files/folders').then((r: any) => setAll((r.folders ?? []).map((f: any) => f.path)), (e: any) => setErr(e.message)) }, [])
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
    return (all ?? []).filter((p) => words.every((w) => p.toLowerCase().includes(w)))
  }, [all, filter])
  const dest = fresh.trim() ? fresh.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/') : target
  const go = async () => {
    if (dest == null) return
    setBusy(true); setErr('')
    try { onMoved(await apiRequest('/files/move', J('POST', { ids, folder: dest })), dest) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const what = ids.length === 1 ? `"${names[0]}"` : `${ids.length} images`
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card lmove" role="dialog" aria-modal="true" aria-labelledby="lmove-t">
        <div className="card-h"><h3 id="lmove-t">Move {what}</h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-b lmove-b">
          <input className="inp" autoFocus placeholder="Find a folder…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a folder" />
          <div className="lmove-list" role="listbox" aria-label="Folders">
            {!all ? <div className="loading">Loading folders…</div> : (
              <>
                {!filter && <FolderChoice path="" flat current={from === ''} sel={!fresh && target === ''} onPick={() => { setFresh(''); setTarget('') }} />}
                {shown.map((p) => <FolderChoice key={p} path={p} flat={!!filter} current={p === from} sel={!fresh && target === p} onPick={() => { setFresh(''); setTarget(p) }} />)}
                {all.length > 0 && !shown.length && <div className="lib-faint" style={{ padding: 8 }}>No folder matches. Create one below.</div>}
              </>
            )}
          </div>
          <label className="lmove-new">
            <span>Or a new folder</span>
            <input className="inp" placeholder="posters/2026 (use / for folders inside folders)" value={fresh} onChange={(e) => setFresh(e.target.value)} />
          </label>
          <div className="lib-faint lmove-note">Images keep their names. Anywhere they are used (assets, channels, metadata, links already shared) keeps working: references are updated and the old address forwards to the new one.</div>
          {err && <div className="asset-img-err">{err}</div>}
        </div>
        <div className="modal-f">
          <span className="lib-faint">{dest == null ? 'Choose a folder' : `To ${dest === '' ? 'the top level' : dest}`}</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || dest == null || (dest === from && ids.length === 1)} onClick={go}>{busy ? 'Moving…' : `Move ${ids.length === 1 ? 'image' : `${ids.length} images`}`}</button>
        </div>
      </div>
    </div>
  )
}

function FolderChoice({ path, flat, current, sel, onPick }: { path: string; flat: boolean; current: boolean; sel: boolean; onPick: () => void }) {
  // The full list reads as a tree (indented, last name); a filtered list shows whole paths.
  const depth = !path || flat ? 0 : path.split('/').length - 1
  const label = !path ? 'Top level (no folder)' : flat ? path : path.split('/').pop()
  return (
    <button type="button" role="option" aria-selected={sel} className={`lmove-opt${sel ? ' sel' : ''}`} onClick={onPick} style={{ paddingLeft: 10 + depth * 14 }} title={path || 'Top level'}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      <span className="lmove-opt-t">{label}</span>
      {current && <span className="lib-faint lmove-opt-p">here now</span>}
    </button>
  )
}

/** One line for after a move: what moved, what did not and why, what was updated. */
export function describeMove(r: MoveOutcome, folder: string): string {
  const where = folder === '' ? 'the top level' : folder
  const refs = Object.values(r.references).reduce((a, b) => a + b, 0)
  const parts = [r.moved.length ? `Moved ${r.moved.length} image${r.moved.length === 1 ? '' : 's'} to ${where}.` : `Nothing was moved to ${where}.`]
  if (refs) parts.push(`Updated ${refs} place${refs === 1 ? '' : 's'} that use${refs === 1 ? 's' : ''} ${r.moved.length === 1 ? 'it' : 'them'}.`)
  if (r.skipped.length) {
    const why = [...new Set(r.skipped.map((s) => s.reason))]
    parts.push(`${r.skipped.length} not moved: ${why.slice(0, 2).join('; ')}${why.length > 2 ? '…' : ''}.`)
  }
  return parts.join(' ')
}

interface Contents { path: string; images: number; here: number; inSubfolders: number; subfolders: string[] }

/** Remove a folder: only when nothing is in it. Shows what is in it otherwise. */
export function DeleteFolderDialog({ path, onClose, onDeleted, onShow }: { path: string; onClose: () => void; onDeleted: (removed: string[]) => void; onShow: () => void }) {
  const [c, setC] = useState<Contents | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { apiRequest(`/files/folders/contents?path=${encodeURIComponent(path)}`).then(setC, (e: any) => setErr(e.message)) }, [path])
  const go = async () => {
    setBusy(true); setErr('')
    try { const r: any = await apiRequest(`/files/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); onDeleted(r.removed ?? [path]) }
    catch (e: any) { setErr(e.message); apiRequest(`/files/folders/contents?path=${encodeURIComponent(path)}`).then(setC, () => {}) }
    finally { setBusy(false) }
  }
  const empty = c && c.images === 0
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" role="dialog" aria-modal="true" aria-labelledby="ldel-t" style={{ width: 460, maxWidth: '95vw', padding: 20 }}>
        <h3 id="ldel-t" style={{ margin: '0 0 8px' }}>Delete folder?</h3>
        <p style={{ margin: '0 0 10px' }}><span className="mono">{path}</span></p>
        {!c && !err && <div className="loading">Checking what is in it…</div>}
        {c && !empty && (
          <div className="ldel-full">
            It holds {c.images} image{c.images === 1 ? '' : 's'}{c.here && c.inSubfolders ? ` (${c.here} here, ${c.inSubfolders} in folders inside it)` : c.inSubfolders ? ', all in folders inside it' : ''}.
            {' '}A folder can only be deleted when it is empty: move or delete {c.images === 1 ? 'the image' : 'the images'} first.
          </div>
        )}
        {c && empty && (
          <div className="lib-faint">
            It is empty{c.subfolders.length ? `, and so ${c.subfolders.length === 1 ? 'is the folder' : `are the ${c.subfolders.length} folders`} inside it, which go too: ${c.subfolders.join(', ')}` : ''}.
          </div>
        )}
        {err && <div className="asset-img-err" style={{ marginTop: 8 }}>{err}</div>}
        <div className="modal-f">
          {c && !empty && <button className="btn ghost" onClick={onShow}>Show {c.images === 1 ? 'it' : 'them'}</button>}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary danger" disabled={busy || !empty} onClick={go}>{busy ? 'Deleting…' : 'Delete folder'}</button>
        </div>
      </div>
    </div>
  )
}

export const DRAG_TYPE = 'application/x-volt-images'

interface DupFile { id: string; path: string; name: string; source: string | null; kind: string; size: number; createdAt: string; url: string }
interface DupGroup { checksum: string; keep: DupFile; drop: DupFile[] }
const kb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`)

/**
 * Images stored more than once (the same bytes). For each set, one stays (a
 * person's upload before one Volt made, then the oldest; click another to keep
 * that instead). Merging points everything that used a copy at the one that
 * stays, forwards the copies' old addresses, and removes the copies.
 */
/** Where images are used (GET /api/files/uses): a channel, an asset, a song, a social post... */
export interface ImageUse { table: string; column: string; id: string | null; label: string | null; what: string }

/** Uses per image id; null while loading; 'error' when it could not be checked (never shown as "not used"). */
export type UsesState = Record<string, ImageUse[]> | null | 'error'
export function useImageUses(ids: string[]): UsesState {
  const [uses, setUses] = useState<UsesState>(null)
  const key = ids.join(',')
  useEffect(() => {
    let gone = false
    setUses(null)
    if (!ids.length) { setUses({}); return }
    const batches: string[][] = []
    for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50))
    Promise.all(batches.map((b) => apiRequest(`/files/uses?ids=${b.join(',')}`).then((r: any) => r.uses ?? {})))
      .then((rs) => { if (!gone) setUses(Object.assign({}, ...rs)) }, () => { if (!gone) setUses('error') })
    return () => { gone = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return uses
}

const useLabel = (u: ImageUse) => (u.label ? `${u.what}: ${u.label}` : u.what)

/** "Used in 3: Channel: Jazz FM, Asset: Late Show, ..." (or "Not used"). */
/** The uses of one image from a UsesState. */
export const usesFor = (state: UsesState, id: string): ImageUse[] | undefined | 'error' =>
  state === 'error' ? 'error' : state ? (state[id] ?? []) : undefined

export function UsesLine({ uses, max = 3 }: { uses: ImageUse[] | undefined | 'error'; max?: number }) {
  if (uses === 'error') return <span className="lrep-uses lrep-unknown">Couldn't check where it is used</span>
  if (!uses) return <span className="lib-faint">Checking where it is used…</span>
  if (!uses.length) return <span className="lib-faint">Not used anywhere</span>
  const names = [...new Set(uses.map(useLabel))]
  return (
    <span className="lrep-uses" title={names.join('\n')}>
      Used in {uses.length}: {names.slice(0, max).join(', ')}{names.length > max ? ` and ${names.length - max} more` : ''}
    </span>
  )
}

export function DuplicatesDialog({ onClose, onMerged }: { onClose: () => void; onMerged: (message: string) => void }) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null)
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)   // a checksum, or 'all'
  const [done, setDone] = useState<{ removed: number; bytes: number; refs: number }>({ removed: 0, bytes: 0, refs: 0 })
  const [err, setErr] = useState('')
  useEffect(() => { apiRequest('/files/duplicates').then((r: any) => setGroups(r.groups), (e: any) => setErr(e.message)) }, [])
  const allIds = useMemo(() => (groups ?? []).flatMap((g) => [g.keep, ...g.drop].map((f) => f.id)), [groups])
  const uses = useImageUses(allIds)
  const copies = (groups ?? []).reduce((n, g) => n + g.drop.length, 0)
  const bytes = (groups ?? []).reduce((n, g) => n + [g.keep, ...g.drop].filter((f) => f.id !== (keep[g.checksum] ?? g.keep.id)).reduce((m, f) => m + f.size, 0), 0)
  const summary = (t: { removed: number; bytes: number; refs: number }) =>
    `Removed ${t.removed} duplicate${t.removed === 1 ? '' : 's'} (${kb(t.bytes)}) to the restore bin${t.refs ? `, and pointed ${t.refs} use${t.refs === 1 ? '' : 's'} at the image that stays` : ''}.`
  const merge = async (checksums: string[] | null) => {
    setBusy(checksums?.[0] ?? 'all'); setErr('')
    try {
      const body: any = { keepers: keep }
      if (checksums) body.checksums = checksums
      const r: any = await apiRequest('/files/duplicates/merge', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
      const refs = Object.values(r.references as Record<string, number>).reduce((a, b) => a + b, 0)
      const t = { removed: done.removed + r.removed, bytes: done.bytes + r.bytes, refs: done.refs + refs }
      const left = checksums ? (groups ?? []).filter((g) => !checksums.includes(g.checksum)) : []
      if (!left.length) { onMerged(summary(t)); return }
      setDone(t); setGroups(left)
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const close = () => { if (done.removed) onMerged(summary(done)); else onClose() }
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) close() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card ldup" role="dialog" aria-modal="true" aria-labelledby="ldup-t">
        <div className="card-h"><h3 id="ldup-t">Duplicate images</h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={close} aria-label="Close">✕</button></div>
        <div className="card-b" style={{ overflow: 'auto' }}>
          {err && <div className="asset-img-err">{err}</div>}
          {!groups && !err && <div className="loading">Looking for images stored more than once…</div>}
          {groups && !groups.length && <div className="lib-faint">No duplicates: every image is stored once.</div>}
          {done.removed > 0 && <div className="lib-faint" style={{ marginBottom: 8 }}>{summary(done)}</div>}
          {groups && groups.length > 0 && (
            <>
              <p className="lib-faint" style={{ marginTop: 0 }}>{groups.length} image{groups.length === 1 ? ' is' : 's are'} stored more than once ({copies} extra cop{copies === 1 ? 'y' : 'ies'}). Click the copy to keep; the others go to the restore bin, and whatever used them (assets, channels, metadata, links) uses the one that stays. For the same picture in different files, open an image and choose <b>Replace with…</b>.</p>
              {groups.map((g) => {
                const k = keep[g.checksum] ?? g.keep.id
                return (
                  <div key={g.checksum} className="ldup-g">
                    <img src={thumbUrl(g.keep.url, 160, 100, 'inside')} alt="" />
                    <div className="ldup-files">
                      {[g.keep, ...g.drop].map((f) => (
                        <button key={f.id} type="button" className={`ldup-f${f.id === k ? ' keep' : ''}`} onClick={() => setKeep({ ...keep, [g.checksum]: f.id })} aria-pressed={f.id === k} disabled={!!busy}>
                          <span className="ldup-mark">{f.id === k ? '✓ stays' : 'goes'}</span>
                          <span className="ldup-pathcol">
                            <span className="mono ldup-path" title={f.path}>{f.path}</span>
                            <UsesLine uses={usesFor(uses, f.id)} max={2} />
                          </span>
                          <span className="lib-faint">{f.source === 'upload' || f.source === 'watchfolder' ? 'uploaded' : 'made by Volt'} · {f.kind} · {new Date(f.createdAt).toLocaleDateString()}</span>
                        </button>
                      ))}
                      <div className="ldup-act">
                        <button className="btn sm" disabled={!!busy} onClick={() => merge([g.checksum])}>{busy === g.checksum ? 'Merging…' : `Keep the ticked copy, remove ${g.drop.length}`}</button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
        <div className="modal-f">
          {groups && groups.length > 0 && <span className="lib-faint">All groups free {kb(bytes)}</span>}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={close} disabled={!!busy}>Close</button>
          <button className="btn primary" disabled={!!busy || !groups?.length} onClick={() => merge(null)}>{busy === 'all' ? 'Merging…' : `Merge all ${groups?.length ?? 0} group${groups?.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * REPLACE WITH ANOTHER IMAGE: the image(s) given go, a chosen one stays. Whatever used them
 * (assets, channels, metadata, song details, links) uses the one that stays, their old
 * addresses forward to it, and they go to the restore bin (POST /api/files/replace).
 * The one that stays can be picked from the library or uploaded right here.
 */
export function ReplaceDialog({ files, onClose, onReplaced }: { files: MediaFile[]; onClose: () => void; onReplaced: (message: string) => void }) {
  const [keep, setKeep] = useState<MediaFile | null>(null)
  const [picking, setPicking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const uses = useImageUses(files.map((f) => f.id))
  const total = uses && uses !== 'error' ? files.reduce((n, f) => n + (uses[f.id]?.length ?? 0), 0) : null
  const what = files.length === 1 ? `"${files[0].name}"` : `${files.length} images`
  const go = async () => {
    if (!keep) return
    setBusy(true); setErr('')
    try {
      const r: any = await apiRequest('/files/replace', J('POST', { keep: keep.id, drop: files.map((f) => f.id) }))
      const refs = Object.values(r.references as Record<string, number>).reduce((a, b) => a + b, 0)
      onReplaced(`Replaced ${what} with "${keep.name}"${refs ? `: ${refs} use${refs === 1 ? '' : 's'} now point at it` : ''}. The old ${files.length === 1 ? 'image is' : 'images are'} in the restore bin.`)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  if (picking) {
    return <ImagePicker open title={`Choose the image that replaces ${what}`} onClose={() => (keep ? setPicking(false) : onClose())}
      onPick={(_url, f) => { if (files.some((x) => x.id === f.id)) { setErr('Choose a different image from the one being replaced.'); setPicking(false); return } setKeep(f); setErr(''); setPicking(false) }}
      uploadKind={files[0]?.kind} uploadFolder={files[0]?.folder || undefined} />
  }
  return (
    <div className="drawer-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }} style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="card lrep" role="dialog" aria-modal="true" aria-labelledby="lrep-t">
        <div className="card-h"><h3 id="lrep-t">Replace {what}</h3><div style={{ flex: 1 }} /><button className="xbtn" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-b lrep-b">
          <div className="lrep-pair">
            <div className="lrep-side">
              <div className="lrep-tag">Goes to the restore bin</div>
              <div className="lrep-imgs">
                {files.slice(0, 4).map((f) => <img key={f.id} src={thumbUrl(f.url, 240, 150, 'inside')} alt={f.name} />)}
                {files.length > 4 && <span className="lib-faint">+{files.length - 4} more</span>}
              </div>
              {files.slice(0, 6).map((f) => (
                <div key={f.id} className="lrep-file"><span className="mono" title={f.path}>{f.path}</span><UsesLine uses={usesFor(uses, f.id)} /></div>
              ))}
            </div>
            <div className="lrep-arrow" aria-hidden>→</div>
            <div className="lrep-side">
              <div className="lrep-tag keep">Stays, and takes over every use</div>
              {keep ? (
                <>
                  <div className="lrep-imgs"><img src={thumbUrl(keep.url, 240, 150, 'inside')} alt={keep.name} /></div>
                  <div className="lrep-file"><span className="mono" title={keep.path}>{keep.path}</span><span className="lib-faint">{keep.width && keep.height ? `${keep.width}×${keep.height}` : ''}</span></div>
                </>
              ) : <div className="lib-faint">No image chosen</div>}
              <button className="btn ghost sm" onClick={() => setPicking(true)} disabled={busy}>{keep ? 'Choose another…' : 'Choose…'}</button>
            </div>
          </div>
          <div className="lib-faint lmove-note">
            {uses === 'error' ? 'Where it is used could not be checked; replacing still moves every use to the image that stays.' : total == null ? 'Checking where it is used…' : total ? `${total} use${total === 1 ? '' : 's'} (assets, channels, metadata, links) will point at the image that stays.` : 'Nothing uses it now.'}
            {' '}Links already shared keep working: the old address opens the image that stays. Restoring from the bin brings the old file back; uses stay on the new one.
          </div>
          {err && <div className="asset-img-err">{err}</div>}
        </div>
        <div className="modal-f">
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={busy || !keep}>{busy ? 'Replacing…' : 'Replace'}</button>
        </div>
      </div>
    </div>
  )
}
