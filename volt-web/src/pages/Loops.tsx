import { useCallback, useEffect, useRef, useState } from 'react'
import { api, thumbUrl, ApiError, type FillerAsset, type FillerElsewhere, type FillerUser } from '../api'
import { navigate, useRoute } from '../router'
import LoopDetail from './LoopDetail'
import {
  cancel, dismiss, initBackground, listResumable,
  resumeWithFile, startUpload, subscribe, type UploadItem,
} from '../uploadManager'
import { pressable } from '../a11y'
import { PageError, useNotify, usePageNotice } from '../notices'

/* ============================================================================
   LOOPS & FILLERS

   The assets a channel falls back to when its input goes away: a slate (a still)
   or a loop (a short video). They are the last thing between a lost feed and a
   black screen, so the list has to answer one question quickly — is the thing
   this channel points at actually there and playable.

   THE UPLOAD IS THE OTHER HALF OF THE PAGE, and it is treated as a first-class
   thing rather than a modal that appears and vanishes. A loop is a video file:
   it is large, it takes time, and the interesting states are the ones where
   something goes wrong halfway. So progress is on the page, interrupted uploads
   are offered back, and what happens if you leave is stated rather than left to
   be discovered.
   ========================================================================== */

const KIND_LABEL: Record<string, string> = { slate: 'Slate', loop: 'Loop' }

const STATUS_TONE: Record<string, string> = {
  ready: 'var(--ok,#4ade80)',
  uploading: 'var(--brand,#3f7bff)',
  processing: 'var(--warn,#fbbf24)',
  error: 'var(--danger,#f87171)',
}

function fmtBytes(n: number | string | null | undefined): string {
  const b = Number(n ?? 0)
  if (!b) return '—'
  const u = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0, v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}
function fmtRate(bytes: number, sinceMs: number): string {
  const s = (Date.now() - sinceMs) / 1000
  if (s < 1 || !bytes) return ''
  return `${fmtBytes(bytes / s)}/s`
}

/** What a file's name says it is, used only to pick a default. */
function guessKind(file: File): 'slate' | 'loop' {
  if (file.type.startsWith('image/')) return 'slate'
  if (file.type.startsWith('video/')) return 'loop'
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name) ? 'slate' : 'loop'
}

// ---------------------------------------------------------------------------
//  The drop zone
// ---------------------------------------------------------------------------
function DropZone({ onFiles, kind, setKind, background }: {
  onFiles: (files: File[]) => void
  kind: 'slate' | 'loop' | 'auto'
  setKind: (k: 'slate' | 'loop' | 'auto') => void
  background: boolean
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // A drag that crosses a child element fires dragleave on the parent. Counting
  // enters and leaves is what stops the zone flickering as the pointer moves
  // over the text inside it.
  const depth = useRef(0)

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) onFiles(files)
  }, [onFiles])

  return (
    <div
      onDragEnter={e => { e.preventDefault(); depth.current++; setOver(true) }}
      onDragLeave={e => { e.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setOver(false) } }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
      style={{
        border: `2px dashed ${over ? 'var(--brand,#3f7bff)' : 'var(--border)'}`,
        background: over ? 'rgba(63,123,255,.08)' : 'var(--panel-2)',
        borderRadius: 10,
        padding: '26px 20px',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'border-color .12s, background .12s',
      }}
    >
      <input ref={inputRef} type="file" multiple
        accept="video/*,image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onFiles(files)
          e.target.value = ''      // so the same file can be chosen twice
        }} />

      <div style={{ fontSize: 'var(--fs-body)', marginBottom: 6 }}>
        {over ? 'Drop to upload' : 'Drop files here, or click to choose'}
      </div>
      <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)', marginBottom: 12 }}>
        Stills become slates, video becomes loops. Large files upload in pieces and
        can be resumed.
      </div>

      <div className="flex items-center justify-center gap-2" {...pressable((e: any) => { (((e: any) => e.stopPropagation()) as any)(e) })} data-a11y-click="">
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Upload as</span>
        <select value={kind} onChange={e => setKind(e.target.value as any)} style={{ width: 200 }}>
          <option value="auto">whatever the file is</option>
          <option value="slate">Slate (a still)</option>
          <option value="loop">Loop (a video)</option>
        </select>
      </div>

      <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)', marginTop: 12 }}>
        {/* Said plainly, because it is the thing people actually want to know and
            the answer differs by browser. */}
        {background
          ? 'Uploads continue in the background even if you close this tab.'
          : 'Uploads continue while you move around the admin. Closing this tab pauses them, and they resume from where they stopped.'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  In-flight uploads
// ---------------------------------------------------------------------------
function UploadRow({ u, onDone }: { u: UploadItem; onDone: () => void }) {
  const pct = u.totalBytes ? Math.min(100, Math.round((u.sentBytes / u.totalBytes) * 100)) : 0
  const done = u.status === 'done'
  const failed = u.status === 'error'

  useEffect(() => { if (done) onDone() /* eslint-disable-next-line */ }, [done])

  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
      <div className="flex flex-wrap items-baseline gap-3" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 'var(--fs-sm)' }}>{u.name}</b>
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>{u.filename}</span>
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>{KIND_LABEL[u.kind]}</span>
        <div className="flex-1" />
        <span style={{
          fontSize: 'var(--fs-sm)',
          color: failed ? 'var(--danger,#f87171)' : done ? 'var(--ok,#4ade80)' : 'var(--muted)',
        }}>
          {failed ? 'Failed'
            : done ? 'Uploaded'
            : u.status === 'assembling' ? 'Assembling…'
            : u.status === 'background' ? `${pct}% · in the background`
            : u.status === 'queued' ? 'Starting…'
            : `${pct}% · ${fmtBytes(u.sentBytes)} of ${fmtBytes(u.totalBytes)} ${fmtRate(u.sentBytes, u.startedAt)}`}
        </span>
        {(done || failed) && (
          <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => dismiss(u.id)}>
            Clear
          </button>
        )}
        {!done && !failed && (
          <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => cancel(u.id)}>
            Cancel
          </button>
        )}
      </div>
      <div style={{ height: 5, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${done ? 100 : pct}%`, height: '100%',
          background: failed ? 'var(--danger,#f87171)'
            : done ? 'var(--ok,#4ade80)'
            : 'var(--brand,#3f7bff)',
          transition: 'width .2s',
        }} />
      </div>
      {failed && u.error && (
        <div style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>
          {u.error}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
const USER_KIND: Record<string, string> = { channel: 'Channel', radio: 'Station', event: 'Event' }

/** The streams that fall back to an asset, each a link to that stream. */
function UsedBy({ users }: { users: FillerUser[] | undefined }) {
  if (!users?.length) return <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Not used</span>
  return (
    <div className="lf-used">
      {users.map(u => (
        <a key={u.kind + u.id} href={u.href} title={`${USER_KIND[u.kind] ?? u.kind}: ${u.name}`}
          onClick={e => { if (e.metaKey || e.ctrlKey || e.button === 1) return; e.preventDefault(); navigate(u.href) }}>{u.name}</a>
      ))}
    </div>
  )
}

/**
 * FALLBACKS THAT ARE NOT HERE YET. Streams set up before 22 Oct picked their
 * slate from the Image Library, so this page could not see them. They still
 * work; this lists them with a one-step copy that also moves the streams over.
 */
function Elsewhere({ items, onCopied }: { items: FillerElsewhere[]; onCopied: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const notify = useNotify()
  if (!items.length) return null
  return (
    <div className="card p-4 lf-elsewhere">
      <div className="sec-label">Fallbacks not in Loops &amp; Fillers yet</div>
      <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
        These streams fall back to an image held somewhere else, usually the Image Library. They still work.
        Copy one in to manage it here; the streams using it move over with it.
      </p>
      <table>
        <thead><tr><th style={{ width: 130 }}>Preview</th><th>Image</th><th>Used by</th><th /></tr></thead>
        <tbody>
          {items.map(it => (
            <tr key={it.ref}>
              <td><img src={thumbUrl(it.ref, 224, 126)} alt="" style={{ width: 112, height: 63, objectFit: 'cover', borderRadius: 4, background: '#000' }} /></td>
              <td>
                <b>{it.libraryFile?.name ?? it.ref.split('/').pop()}</b>
                <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>{it.libraryFile ? `Image Library · ${it.libraryFile.path}` : it.ref}</div>
              </td>
              <td><UsedBy users={it.usedBy} /></td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {it.canCopy ? (
                  <button className="btn primary" disabled={busy === it.ref} onClick={async () => {
                    setBusy(it.ref)
                    try {
                      const r = await api.copyFillerFromLibrary(it.ref)
                      notify({ kind: 'ok', message: `Copied into Loops & Fillers. ${r.relinked.length} stream${r.relinked.length === 1 ? ' now uses' : 's now use'} it.` })
                      onCopied()
                    } catch (e: any) { notify({ kind: 'error', message: e.message }) } finally { setBusy(null) }
                  }}>{busy === it.ref ? 'Copying…' : 'Copy into Loops & Fillers'}</button>
                ) : (
                  <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>Not an Image Library file: choose a fallback on the stream</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function LoopsPage() {
  // /loops/:id is one item's details (LoopDetail.tsx); /loops is the list
  const route = useRoute()
  const detailId = route.path.replace(/^\/+|\/+$/g, '').split('/')[1]
  if (detailId) return <LoopDetail key={detailId} id={decodeURIComponent(detailId)} />
  return <LoopsList />
}

function LoopsList() {
  const [assets, setAssets] = useState<FillerAsset[] | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [resumable, setResumable] = useState<any[]>([])
  const [kind, setKind] = useState<'slate' | 'loop' | 'auto'>('auto')
  const [background, setBackground] = useState(false)
  const [err, setErr] = useState('')
  const notify = useNotify()
  const fail = (m: string) => notify({ kind: 'error', message: m })
  const [filter, setFilter] = useState<'all' | 'slate' | 'loop'>('all')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [rename, setRename] = useState('')
  const resumeInput = useRef<HTMLInputElement | null>(null)
  const resumeTarget = useRef<string | null>(null)

  const [elsewhere, setElsewhere] = useState<FillerElsewhere[]>([])
  async function load() {
    try { setAssets(await api.fillerAssets()); setErr('') }
    catch (e: any) { setErr(e.message) }
    api.fillerElsewhere().then(r => setElsewhere(r.items)).catch(() => setElsewhere([]))
  }

  useEffect(() => {
    load()
    // The manager is a module singleton, so this only attaches a view to
    // whatever is already running — including uploads started before this page
    // was opened.
    const off = subscribe(setUploads)
    initBackground().then(setBackground)
    listResumable().then(setResumable).catch(() => setResumable([]))
    return off
  }, [])

  const onFiles = useCallback((files: File[]) => {
    for (const f of files) {
      startUpload(f, { kind: kind === 'auto' ? guessKind(f) : kind })
        .catch((e: any) => fail(e.message))
    }
  }, [kind])

  const shown = (assets ?? []).filter(a => filter === 'all' || a.kind === filter)

  usePageNotice('load', err && assets ? { kind: 'error', title: "Couldn't load loops and fillers.", message: err, actions: [{ label: 'Retry', onClick: () => { load() } }] } : null)

  if (err && !assets) return <PageError message={err} onRetry={load} />
  if (!assets) return <div className="loading">Loading loops and fillers…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Loops &amp; Fillers</h1>
          <p>What a channel falls back to when its input goes away.</p>
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <DropZone onFiles={onFiles} kind={kind} setKind={setKind} background={background} />
      </div>

      {/* INTERRUPTED UPLOADS. Offered back rather than left for the sweep,
          because the alternative is someone re-uploading two gigabytes that are
          already ninety per cent on the server. The file has to be chosen again:
          a browser will not hand a page a file the user did not just pick, and
          no amount of wanting changes that. */}
      <Elsewhere items={elsewhere} onCopied={load} />

      {resumable.length > 0 && (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <div className="sec-label">Unfinished uploads</div>
          <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
            These were interrupted. Everything already sent is still on the server;
            choose the same file again and it will carry on from there.
          </p>
          <input ref={resumeInput} type="file" style={{ display: 'none' }}
            onChange={async e => {
              const f = e.target.files?.[0]
              const sid = resumeTarget.current
              e.target.value = ''
              if (!f || !sid) return
              try {
                await resumeWithFile(sid, f)
                setResumable(r => r.filter(x => x.sessionId !== sid))
              } catch (ex: any) { fail(ex.message) }
            }} />
          <table>
            <thead><tr><th>Name</th><th>File</th><th>Progress</th><th /></tr></thead>
            <tbody>
              {resumable.map(r => (
                <tr key={r.sessionId}>
                  <td><b>{r.name}</b></td>
                  <td style={{ color: 'var(--muted)' }}>{r.filename}</td>
                  <td style={{ color: 'var(--muted)' }}>
                    {fmtBytes(r.receivedBytes)} of {fmtBytes(r.totalBytes)}
                    <span style={{ color: 'var(--faint)' }}> ({r.received}/{r.chunkCount} pieces)</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn primary" onClick={() => {
                      resumeTarget.current = r.sessionId
                      resumeInput.current?.click()
                    }}>Choose the file and resume</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="card p-4" style={{ marginBottom: 16 }}>
          <div className="sec-label">Uploading</div>
          {uploads.map(u => <UploadRow key={u.id} u={u} onDone={load} />)}
        </div>
      )}

      <div className="card">
        <div className="flex items-center gap-2" style={{ padding: '12px 14px 0' }}>
          {(['all', 'loop', 'slate'] as const).map(f => (
            <button key={f} className={`btn ${filter === f ? 'primary' : 'ghost'}`}
              style={{ padding: '3px 10px', fontSize: 'var(--fs-sm)' }}
              onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : `${KIND_LABEL[f]}s`}
            </button>
          ))}
          <div className="flex-1" />
          <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>
            {shown.length} of {assets.length}
          </span>
        </div>
        <table>
          <thead>
            <tr><th style={{ width: 130 }}>Preview</th><th>Name</th><th>Kind</th><th>Used by</th><th>Size</th><th>Status</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {shown.map(a => (
              <tr key={a.id}>
                <td>
                  {/* The preview opens the item's details, like the Details button: users expect a thumbnail to be clickable. */}
                  <a href={`/loops/${a.id}`} title={`Open ${a.name}`} aria-label={`Open details for ${a.name}`}
                    style={{ display: 'block', width: 112, height: 63, cursor: 'pointer' }}
                    onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; e.preventDefault(); navigate(`/loops/${a.id}`) }}>
                  {a.status === 'ready' && a.source_key ? (
                    a.kind === 'slate'
                      ? <img src={`/${a.source_key}`} alt=""
                          style={{ width: 112, height: 63, objectFit: 'cover', borderRadius: 4, background: '#000' }} />
                      : <video src={`/${a.source_key}`} muted preload="metadata"
                          onMouseEnter={e => { void (e.currentTarget as HTMLVideoElement).play().catch(() => {}) }}
                          onMouseLeave={e => { const v = e.currentTarget as HTMLVideoElement; v.pause(); v.currentTime = 0 }}
                          style={{ width: 112, height: 63, objectFit: 'cover', borderRadius: 4, background: '#000' }} />
                  ) : (
                    <div style={{
                      width: 112, height: 63, borderRadius: 4, background: 'var(--panel-2)',
                      display: 'grid', placeItems: 'center',
                      color: 'var(--faint)', fontSize: 'var(--fs-micro)',
                    }}>{a.status === 'uploading' ? 'uploading' : 'no preview'}</div>
                  )}
                  </a>
                </td>
                <td>
                  {renaming === a.id ? (
                    <div className="flex items-center gap-2">
                      <input value={rename} onChange={e => setRename(e.target.value)}
                        style={{ width: 200 }} autoFocus
                        onKeyDown={async e => {
                          if (e.key === 'Escape') setRenaming(null)
                          if (e.key === 'Enter' && rename.trim()) {
                            try { await api.patchFillerAsset(a.id, { name: rename.trim() }); setRenaming(null); load() }
                            catch (ex: any) { fail(ex.message) }
                          }
                        }} />
                      <button className="btn ghost" onClick={() => setRenaming(null)}>Cancel</button>
                    </div>
                  ) : (
                    <b style={{ cursor: 'pointer' }}
                      onClick={() => { setRenaming(a.id); setRename(a.name) }}>{a.name}</b>
                  )}
                  {a.filename && a.filename !== a.name && (
                    <div style={{ color: 'var(--faint)', fontSize: 'var(--fs-micro)' }}>{a.filename}</div>
                  )}
                </td>
                <td style={{ color: 'var(--muted)' }}>{KIND_LABEL[a.kind] ?? a.kind}</td>
                <td><UsedBy users={a.used_by} /></td>
                <td style={{ color: 'var(--muted)' }}>{fmtBytes(a.bytes)}</td>
                <td style={{ color: STATUS_TONE[a.status] ?? 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                  {a.status}
                  {a.error && <div style={{ color: 'var(--danger,#f87171)', fontSize: 'var(--fs-micro)' }}>{a.error}</div>}
                </td>
                <td style={{ color: 'var(--muted)' }}>{new Date(a.created_at).toLocaleString()}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a className="btn ghost" href={`/loops/${a.id}`}
                    onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(`/loops/${a.id}`) }}>Details</a>
                  <button className="btn ghost" style={{ marginLeft: 6 }}
                    onClick={async () => {
                      const users = a.used_by ?? []
                      if (!users.length) {
                        if (!confirm(`Delete "${a.name}"? This can't be undone.`)) return
                        try { await api.deleteFillerAsset(a.id); load() } catch (ex: any) { fail(ex.message) }
                        return
                      }
                      // IN USE: the server refuses unless forced, and names the streams.
                      if (!confirm(`"${a.name}" is the fallback for ${users.map(u => u.name).join(', ')}. Deleting it leaves ${users.length === 1 ? 'that stream' : 'those streams'} with no fallback. Delete anyway?`)) return
                      try { await api.deleteFillerAsset(a.id, true); load() }
                      catch (ex: any) { fail(ex instanceof ApiError && ex.body?.message ? ex.body.message : ex.message) }
                    }}>Delete</button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={8} style={{ color: 'var(--faint)' }}>
                Nothing here yet. Drop a file above to add one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
