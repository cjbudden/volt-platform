// Background upload manager. Lives outside the component tree (module singleton) so
// uploads keep running while you navigate between pages. A global indicator (topbar)
// shows progress; pages subscribe via useUploads() and refresh as items complete.
import { useSyncExternalStore, useEffect, useState } from 'react'
import { api } from './api'

export type UpStatus = 'queued' | 'uploading' | 'done' | 'error'
export interface UploadJob { id: string; name: string; folder: string; kind: string; size: number; status: UpStatus; error?: string }
interface State { jobs: UploadJob[]; seq: number } // seq bumps on each successful upload (pages watch it)

let state: State = { jobs: [], seq: 0 }
const fileById = new Map<string, File>()
const listeners = new Set<() => void>()
let running = false
let counter = 0

function emit() { for (const l of listeners) l() }
function setJobs(jobs: UploadJob[], bump = false) { state = { jobs, seq: state.seq + (bump ? 1 : 0) }; emit() }
function patch(id: string, p: Partial<UploadJob>, bump = false) { setJobs(state.jobs.map(j => (j.id === id ? { ...j, ...p } : j)), bump) }

function fileToDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file) })
}

export function enqueueUploads(items: { file: File; folder: string; name: string; kind: string }[]) {
  const jobs = items.map((it) => { const id = 'u' + (++counter); fileById.set(id, it.file); return { id, name: it.name, folder: it.folder, kind: it.kind, size: it.file.size, status: 'queued' as UpStatus } })
  setJobs([...state.jobs, ...jobs])
  void run()
}

async function run() {
  if (running) return
  running = true
  try {
    for (;;) {
      const job = state.jobs.find((j) => j.status === 'queued')
      if (!job) break
      patch(job.id, { status: 'uploading' })
      const file = fileById.get(job.id)
      try {
        if (!file) throw new Error('file missing')
        if (file.size > 28 * 1024 * 1024) throw new Error(`too large (${(file.size / 1048576).toFixed(1)} MB)`)
        const dataUrl = await fileToDataURL(file)
        await api.uploadFile({ folder: job.folder, name: job.name, kind: job.kind, contentType: file.type, dataBase64: dataUrl })
        patch(job.id, { status: 'done' }, true)
      } catch (e: any) { patch(job.id, { status: 'error', error: e.message }) }
      fileById.delete(job.id)
    }
  } finally { running = false }
}

export function clearFinished() { setJobs(state.jobs.filter((j) => j.status === 'queued' || j.status === 'uploading')) }
export function retryFailed() {
  setJobs(state.jobs.map((j) => (j.status === 'error' ? { ...j, status: 'queued', error: undefined } : j)))
  void run()
}

export function useUploads() {
  const snap = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => state, () => state)
  const jobs = snap.jobs
  return {
    jobs, seq: snap.seq,
    active: jobs.filter((j) => j.status === 'queued' || j.status === 'uploading').length,
    done: jobs.filter((j) => j.status === 'done').length,
    failed: jobs.filter((j) => j.status === 'error').length,
    total: jobs.length,
  }
}

/** Compact topbar indicator — shows while uploads run, a done flash after, and errors. */
export function UploadIndicator() {
  const u = useUploads()
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (u.total > 0 && u.active === 0 && u.failed === 0) {
      setFlash(true)
      const t = setTimeout(() => { setFlash(false); clearFinished() }, 3000)
      return () => clearTimeout(t)
    }
  }, [u.active, u.total, u.failed])

  if (u.total === 0) return null
  const label = u.active > 0 ? `↑ ${u.done}/${u.total}` : u.failed > 0 ? `${u.failed} failed` : flash ? `✓ ${u.done}` : null
  if (label === null) return null

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost" onClick={() => setOpen(o => !o)} style={u.failed ? { color: '#fca5a5' } : undefined}>
        {u.active > 0 && <span className="dot-s warn" style={{ marginRight: 6 }} />}{label}
      </button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 42, width: 300, zIndex: 60, padding: 10, maxHeight: 340, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <b style={{ fontSize: 'var(--fs-body)' }}>Uploads</b><span style={{ flex: 1 }} />
            {u.failed > 0 && <button className="chip" onClick={retryFailed} style={{ padding: '3px 9px', marginRight: 6 }}>Retry failed</button>}
            <button className="chip" onClick={clearFinished} style={{ padding: '3px 9px' }}>Clear</button>
          </div>
          {u.jobs.slice().reverse().map(j => (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', fontSize: 'var(--fs-sm)' }}>
              <span style={{ width: 16, textAlign: 'center' }}>{j.status === 'done' ? <span style={{ color: 'var(--live)' }}>✓</span> : j.status === 'error' ? <span style={{ color: 'var(--down)' }} title={j.error}>!</span> : j.status === 'uploading' ? <span className="dot-s warn" /> : '·'}</span>
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={j.error || j.name}>{j.name}</span>
              <span style={{ color: 'var(--faint)' }}>{j.folder || 'root'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
