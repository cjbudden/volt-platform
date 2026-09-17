import { getToken } from './api'

/* ============================================================================
   THE UPLOAD MANAGER

   A module-level singleton, deliberately. Uploads must not be page state: hang
   them off a React component and navigating from Loops & Fillers to Channels
   unmounts the component and kills the transfer. Living here, they survive every
   move around the admin, because a single-page app never actually unloads the
   document.

   WHAT "CONTINUE WHEN YOU LEAVE THE PAGE" HONESTLY MEANS. There are three
   different things people mean by it, and this handles all three differently:

     MOVING AROUND THE ADMIN   nothing happens. The document is the same one, and
                               this module is still running.

     CLOSING THE TAB, with Background Fetch (Chrome, Edge): the browser owns the
                               transfer. It carries on with the tab closed, shows
                               its own progress UI, and wakes the service worker
                               when it lands so the file can be assembled.

     CLOSING THE TAB, without it (Firefox, Safari): the transfer stops, because
                               nothing in those browsers can continue it. What it
                               does NOT do is lose the work: every chunk already
                               delivered is on the server, so reopening the page
                               resumes from where it stopped rather than from
                               zero.

   The last case is why the protocol is chunked at all. Background Fetch is a
   bonus on top of resumability, not a substitute for it — and building the
   fallback first is what stops two thirds of browsers getting a worse product.
   ========================================================================== */

export type UploadStatus =
  | 'queued' | 'uploading' | 'assembling' | 'done' | 'error' | 'paused' | 'background'

export interface UploadItem {
  /** Local id, stable for the lifetime of this tab. */
  id: string
  sessionId: string | null
  token: string | null
  assetId: string | null
  file: File | null
  name: string
  filename: string
  kind: 'slate' | 'loop'
  totalBytes: number
  sentBytes: number
  chunkSize: number
  chunkCount: number
  received: number[]
  status: UploadStatus
  error: string | null
  /** True when the browser, not this page, is carrying the transfer. */
  background: boolean
  /** Set by cancel(). In-page workers check it between chunks and stop; without
   *  it a cancelled upload kept PUTting chunks at a deleted session until the
   *  whole file had been sent. */
  cancelled?: boolean
  /** Set by pause(). Workers stop between chunks; resume() re-drives from the server's count. */
  paused?: boolean
  startedAt: number
  /** Bytes per second over the last few seconds, for the queue's speed and ETA. */
  rate?: number
  /** What the ingest rules decided when the bytes landed (vod uploads). */
  ingest?: IngestOutcome | null
}

export interface IngestOutcome {
  status: 'ingested' | 'awaiting_metadata' | 'duplicate' | 'rejected'
  naming?: { mode: string; structure: string; guid: string; renamed: boolean }
  duplicate?: { outcome: string; ofAssetId: string | null; strength: string | null } | null
  rules?: { rung: string; ruleId: string; ruleName: string }[]
  awaitingMetadata?: string[] | null
  title?: string | null
}

type Listener = (items: UploadItem[]) => void

const items = new Map<string, UploadItem>()
const listeners = new Set<Listener>()
/** Sessions this tab could resume, remembered across a reload. */
const RESUME_KEY = 'volt.uploads.resume'

let seq = 0
const nextId = () => `u${++seq}-${Date.now().toString(36)}`

function emit() {
  const snapshot = [...items.values()].sort((a, b) => a.startedAt - b.startedAt)
  for (const l of listeners) l(snapshot)
}

export function subscribe(l: Listener): () => void {
  listeners.add(l)
  l([...items.values()].sort((a, b) => a.startedAt - b.startedAt))
  return () => { listeners.delete(l) }
}

/** Is anything still moving? Drives the leave-the-page warning. */
export function inFlight(): UploadItem[] {
  return [...items.values()].filter(i =>
    i.status === 'uploading' || i.status === 'assembling' || i.status === 'queued')
}

// ---------------------------------------------------------------------------
//  Remembering what could be resumed
// ---------------------------------------------------------------------------
/**
 * A reload loses the File objects, and nothing can get them back: the browser
 * will not hand a page a file the user has not just chosen. So what is kept is
 * the SESSION, not the bytes — enough to tell the user "this upload is 60% done,
 * pick the file again and it will finish from there".
 */
interface RememberedSession {
  sessionId: string; token: string; name: string; filename: string
  kind: 'slate' | 'loop'; totalBytes: number
}

function remembered(): RememberedSession[] {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '[]') } catch { return [] }
}
function remember(s: RememberedSession) {
  try {
    const all = remembered().filter(x => x.sessionId !== s.sessionId)
    all.push(s)
    localStorage.setItem(RESUME_KEY, JSON.stringify(all.slice(-20)))
  } catch { /* private mode, a quota, whatever: this is a convenience */ }
}
function forget(sessionId: string) {
  try {
    localStorage.setItem(RESUME_KEY,
      JSON.stringify(remembered().filter(x => x.sessionId !== sessionId)))
  } catch { /* */ }
}

// ---------------------------------------------------------------------------
//  Background Fetch
// ---------------------------------------------------------------------------
let swReg: ServiceWorkerRegistration | null = null
let swTried = false

export function backgroundSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && !!swReg
    && 'backgroundFetch' in swReg
}

/**
 * Register the worker that owns background transfers.
 *
 * Called once, lazily. A failure here is not an error the user needs to see: it
 * means this browser gets the resumable path, which is the same product minus
 * one convenience.
 */
export async function initBackground(): Promise<boolean> {
  if (swTried) return backgroundSupported()
  swTried = true
  if (!('serviceWorker' in navigator)) return false
  try {
    swReg = await navigator.serviceWorker.register('/upload-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    navigator.serviceWorker.addEventListener('message', onWorkerMessage)
    return backgroundSupported()
  } catch {
    swReg = null
    return false
  }
}

/** The worker tells us how a background transfer went. */
function onWorkerMessage(ev: MessageEvent) {
  const m = ev.data
  if (!m || typeof m !== 'object' || m.channel !== 'volt-upload') return
  const item = [...items.values()].find(i => i.sessionId === m.sessionId)
  if (!item) return
  if (m.type === 'progress') {
    item.sentBytes = Math.min(item.totalBytes, m.sentBytes ?? item.sentBytes)
    item.status = 'background'
  } else if (m.type === 'done') {
    item.sentBytes = item.totalBytes
    item.status = 'done'
    item.assetId = m.assetId ?? item.assetId
    forget(item.sessionId!)
  } else if (m.type === 'error') {
    item.status = 'error'
    item.error = m.error ?? 'The background upload failed.'
  }
  emit()
}

// ---------------------------------------------------------------------------
//  Starting an upload
// ---------------------------------------------------------------------------
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch('/api' + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken()}`,
      ...(init?.headers ?? {}),
    },
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error || msg } catch { /* */ }
    throw new Error(msg)
  }
  return r.status === 204 ? (null as T) : r.json()
}

export interface StartOptions {
  kind: 'slate' | 'loop'
  name?: string
  /**
   * 'vod' uploads a programme rather than a filler asset: it creates a VOD
   * asset and, when the bytes land, an encode job on the chosen ladder. The
   * `kind` above is ignored for these — a VOD is not a slate or a loop.
   */
  purpose?: 'filler' | 'vod'
  /** 'vod' only. Omitted takes the account default AT ENCODE TIME, so a default
   *  changed during a long upload is still the one that applies. */
  ladderGroupId?: string | null
  /** Ingest framework: the path inside a dropped or picked folder, the content
   *  type chosen up front, metadata typed before upload, the source rung. */
  relativePath?: string | null
  schemaId?: string | null
  metadata?: Record<string, any> | null
  source?: string
}

export async function startUpload(file: File, opts: StartOptions): Promise<UploadItem> {
  const item: UploadItem = {
    id: nextId(), sessionId: null, token: null, assetId: null, file,
    name: opts.name?.trim() || file.name.replace(/\.[^.]+$/, ''),
    filename: file.name, kind: opts.kind,
    totalBytes: file.size, sentBytes: 0,
    chunkSize: 0, chunkCount: 0, received: [],
    status: 'queued', error: null, background: false, startedAt: Date.now(),
  }
  items.set(item.id, item)
  emit()

  try {
    const s = await api<any>('/uploads', {
      method: 'POST',
      body: JSON.stringify({
        purpose: opts.purpose ?? 'filler',
        ...(opts.purpose === 'vod'
          ? { ladderGroupId: opts.ladderGroupId ?? null,
              relativePath: opts.relativePath ?? ((file as any).webkitRelativePath || null),
              schemaId: opts.schemaId ?? null, metadata: opts.metadata ?? undefined,
              source: opts.source ?? 'panel' }
          : { fillerKind: opts.kind }),
        name: item.name,
        filename: file.name, contentType: file.type || 'application/octet-stream',
        totalBytes: file.size,
      }),
    })
    item.sessionId = s.id
    item.token = s.token
    item.assetId = s.assetId
    item.chunkSize = s.chunkSize
    item.chunkCount = s.chunkCount
    item.received = s.received ?? []
    remember({
      sessionId: s.id, token: s.token, name: item.name,
      filename: file.name, kind: opts.kind, totalBytes: file.size,
    })
  } catch (e: any) {
    item.status = 'error'
    item.error = e.message
    emit()
    return item
  }

  void drive(item)
  return item
}

/** Attach a re-chosen file to a session that was left part-finished. */
export async function resumeWithFile(sessionId: string, file: File): Promise<UploadItem | null> {
  const mem = remembered().find(s => s.sessionId === sessionId)
  if (!mem) return null
  if (file.size !== mem.totalBytes) {
    throw new Error(
      `That file is ${file.size} bytes and the interrupted upload was ${mem.totalBytes}. ` +
      `Pick the same file, or start a new upload.`
    )
  }
  let state: any
  try {
    state = await fetch(`/api/uploads/${sessionId}/state`, {
      headers: { authorization: `Bearer ${mem.token}` },
    }).then(r => r.ok ? r.json() : Promise.reject(new Error('That upload has expired.')))
  } catch (e: any) {
    forget(sessionId)
    throw e
  }

  const item: UploadItem = {
    id: nextId(), sessionId, token: mem.token, assetId: null, file,
    name: mem.name, filename: mem.filename, kind: mem.kind,
    totalBytes: mem.totalBytes, sentBytes: state.receivedBytes ?? 0,
    chunkSize: state.chunkSize, chunkCount: state.chunkCount,
    received: state.received ?? [],
    status: 'queued', error: null, background: false, startedAt: Date.now(),
  }
  items.set(item.id, item)
  emit()
  void drive(item)
  return item
}

/** Interrupted uploads this tab knows about, with how far each one got. */
export async function listResumable(): Promise<Array<RememberedSession & {
  received: number; chunkCount: number; receivedBytes: number
}>> {
  const out: Array<any> = []
  for (const s of remembered()) {
    try {
      const r = await fetch(`/api/uploads/${s.sessionId}/state`, {
        headers: { authorization: `Bearer ${s.token}` },
      })
      if (!r.ok) { forget(s.sessionId); continue }
      const st = await r.json()
      if (st.state !== 'open') { forget(s.sessionId); continue }
      out.push({ ...s, received: (st.received ?? []).length, chunkCount: st.chunkCount, receivedBytes: st.receivedBytes })
    } catch { /* offline: leave it remembered and try again later */ }
  }
  return out
}

/**
 * Did the browser actually START carrying it?
 *
 * Asks the SERVER, not the registration: the server is the only party that
 * knows what arrived, and after a resume it is the only one that is right.
 * A background fetch that has moved nothing after the grace window is treated
 * as not working, and the page takes the transfer back.
 *
 * Kept short deliberately. The cost of being wrong in one direction is a few
 * chunks uploaded twice, which is free because chunks are idempotent; the cost
 * in the other direction is an upload that never finishes and never says so.
 */
const BG_GRACE_MS = 15_000
const BG_POLL_MS = 2_500

async function backgroundIsMoving(item: UploadItem): Promise<boolean> {
  const started = Date.now()
  const before = item.received.length
  while (Date.now() - started < BG_GRACE_MS) {
    await new Promise((r) => setTimeout(r, BG_POLL_MS))
    // The tab may have been closed and reopened; if the item is gone, the
    // supervision goes with it and the browser is on its own, as intended.
    if (!items.has(item.id)) return true
    const state = await serverState(item)
    if (!state) continue
    item.received = state.received
    item.sentBytes = state.receivedBytes
    emit()
    if (state.state === 'complete') {
      item.status = 'done'
      if (item.sessionId) forget(item.sessionId)
      emit(); return true
    }
    if (state.received.length > before) return true    // it is moving; leave it alone
  }
  console.warn('[upload] background fetch registered but moved nothing in',
    BG_GRACE_MS, 'ms — uploading in the page instead')
  return false
}

/** What the server has actually received for this session. */
async function serverState(item: UploadItem): Promise<
  { received: number[]; receivedBytes: number; state: string } | null
> {
  if (!item.sessionId || !item.token) return null
  try {
    const r = await fetch(`/api/uploads/${item.sessionId}/state`, {
      headers: { authorization: `Bearer ${item.token}` },
    })
    if (!r.ok) return null
    const j = await r.json()
    return { received: j.received ?? [], receivedBytes: j.receivedBytes ?? 0, state: j.state }
  } catch { return null }
}

/** Stop a background fetch we have decided is not working, so it cannot later
 *  wake up and race the in-page upload. Best effort: an abort that fails is
 *  harmless, because every chunk write is idempotent. */
async function abandonBackgroundFetch(item: UploadItem): Promise<void> {
  try {
    const bg = (swReg as any)?.backgroundFetch
    const reg = await bg?.get?.(`volt-upload-${item.sessionId}`)
    await reg?.abort?.()
  } catch { /* nothing to abort */ }
  item.background = false
}

// ---------------------------------------------------------------------------
//  Driving one upload
// ---------------------------------------------------------------------------
/** How many chunks are in flight at once. Enough to fill a fat pipe, few enough
 *  that one stalled request does not hold up everything. */
const PARALLEL = 3

async function drive(item: UploadItem): Promise<void> {
  if (!item.file || !item.sessionId || !item.token) return

  // Prefer the browser carrying it, when the browser can.
  if (backgroundSupported()) {
    try {
      await startBackgroundFetch(item)
      // REGISTERING IS NOT UPLOADING. bg.fetch() resolves as soon as the
      // browser accepts the registration, which tells us nothing about whether
      // it will ever run the requests — and several environments accept one
      // and then do nothing at all. Nothing downstream checked, so the item sat
      // at "background" with zero bytes sent, no error, and no timeout, for as
      // long as the tab stayed open. Watch it; if it has not moved, take the
      // transfer back.
      if (await backgroundIsMoving(item)) return
      await abandonBackgroundFetch(item)
      // fall through and upload in the page instead
    } catch {
      // A browser that advertises Background Fetch and then refuses is not
      // worth arguing with.
    }
  }

  item.status = 'uploading'
  item.background = false
  emit()

  const missing: number[] = []
  const have = new Set(item.received)
  for (let i = 0; i < item.chunkCount; i++) if (!have.has(i)) missing.push(i)

  let next = 0
  let failed: string | null = null

  async function worker() {
    for (;;) {
      const i = next++
      // Cancellation is checked HERE, between chunks, because a chunk already
      // in flight cannot be recalled and the next one is the earliest thing we
      // control.
      if (i >= missing.length || failed || item.cancelled || item.paused) return
      const index = missing[i]
      const start = index * item.chunkSize
      const blob = item.file!.slice(start, Math.min(start + item.chunkSize, item.totalBytes))
      try {
        const r = await fetch(`/api/uploads/${item.sessionId}/chunks/${index}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${item.token}`,
            'content-type': 'application/octet-stream',
          },
          body: blob,
        })
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error || `chunk ${index} failed (${r.status})`)
        }
        const out = await r.json()
        // Progress comes from the SERVER's count, not from what this tab thinks
        // it sent. They differ after a resume, and the server is the one that
        // knows.
        const now = Date.now(); const prev = (item as any)._r as { t: number; b: number } | undefined
        if (prev && now - prev.t > 1500) { item.rate = ((out.receivedBytes - prev.b) * 1000) / (now - prev.t); (item as any)._r = { t: now, b: out.receivedBytes } }
        else if (!prev) (item as any)._r = { t: now, b: out.receivedBytes }
        item.sentBytes = out.receivedBytes
        if (Array.isArray(out.receivedIndices)) item.received = out.receivedIndices   // so a resume sends only what is missing
        emit()
      } catch (e: any) {
        failed = e.message
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PARALLEL, missing.length || 1) }, worker))

  if (failed) {
    item.status = 'error'
    item.error = failed
    emit()
    return
  }
  // Paused or cancelled between chunks: leave the row as it is, nothing to assemble yet.
  if (item.paused || item.cancelled) return

  item.status = 'assembling'
  emit()
  try {
    const done = await fetch(`/api/uploads/${item.sessionId}/finish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${item.token}` },
    })
    if (!done.ok) {
      const body = await done.json().catch(() => ({}))
      throw new Error(body.error || `assembly failed (${done.status})`)
    }
    const out = await done.json()
    item.assetId = out.assetId ?? item.assetId
    item.ingest = out.ingest ?? null
    item.sentBytes = item.totalBytes
    item.status = 'done'
    forget(item.sessionId)
  } catch (e: any) {
    item.status = 'error'
    item.error = e.message
  }
  emit()
}

/**
 * Hand the whole transfer to the browser.
 *
 * Background Fetch takes a LIST of requests and gives no ordering guarantee,
 * which is exactly why the chunks are independently addressed: chunk 47 means
 * the same thing whenever it arrives. A protocol that needed sequential appends
 * could not use this API at all.
 *
 * The requests are built HERE, in the page, so each one carries the session's
 * capability token in its headers. The worker never needs the user's access
 * token, and could not read it if it did.
 */
async function startBackgroundFetch(item: UploadItem): Promise<void> {
  if (!swReg || !item.file || !item.sessionId || !item.token) throw new Error('no worker')

  const have = new Set(item.received)
  const requests: Request[] = []
  for (let i = 0; i < item.chunkCount; i++) {
    if (have.has(i)) continue
    const start = i * item.chunkSize
    const blob = item.file.slice(start, Math.min(start + item.chunkSize, item.totalBytes))
    requests.push(new Request(`/api/uploads/${item.sessionId}/chunks/${i}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${item.token}`,
        'content-type': 'application/octet-stream',
      },
      body: blob,
    }))
  }
  if (!requests.length) {
    // Everything is already there; only the assembly is left.
    item.status = 'assembling'; emit()
    await fetch(`/api/uploads/${item.sessionId}/finish`, {
      method: 'POST', headers: { authorization: `Bearer ${item.token}` },
    })
    item.status = 'done'; item.sentBytes = item.totalBytes; forget(item.sessionId); emit()
    return
  }

  const bg = (swReg as any).backgroundFetch
  const reg = await bg.fetch(`volt-upload-${item.sessionId}`, requests, {
    title: `Uploading ${item.filename}`,
    downloadTotal: item.totalBytes,
  })

  item.background = true
  item.status = 'background'
  emit()

  // The worker owns completion. This is only so the page shows movement while
  // it is open; with the tab closed the browser carries on regardless.
  reg.addEventListener?.('progress', () => {
    item.sentBytes = Math.min(item.totalBytes, reg.uploaded ?? item.sentBytes)
    if (reg.result === 'failure') { item.status = 'error'; item.error = reg.failureReason || 'failed' }
    emit()
  })
}

/** Stop between chunks; nothing already sent is lost. */
export function pause(id: string) {
  const item = items.get(id)
  if (!item || item.status !== 'uploading') return
  item.paused = true
  item.status = 'paused'
  item.rate = 0
  emit()
}

/** Continue from the server's count of what landed. */
export function resume(id: string) {
  const item = items.get(id)
  if (!item || item.status !== 'paused' || !item.file) return
  item.paused = false
  item.status = 'queued'
  emit()
  void drive(item)
}

export function dismiss(id: string) {
  items.delete(id)
  emit()
}

export async function cancel(id: string) {
  const item = items.get(id)
  if (!item) return
  // ABORT THE BROWSER'S TRANSFER FIRST.
  //
  // Cancel used to delete the server session and drop the row, and stop there.
  // A Background Fetch belongs to the BROWSER, not to this page: the row
  // vanished from the app while the browser carried on uploading, at full
  // speed, to a session that no longer existed — every chunk 404ing, on the
  // user's bandwidth, with no handle left anywhere to stop it. On a phone that
  // is somebody's data allowance.
  //
  // Aborting before deleting the session also gets the order right: kill the
  // producer, then remove what it was writing to.
  if (item.background) await abandonBackgroundFetch(item)
  item.cancelled = true          // in-page drivers check this between chunks
  if (item.sessionId) {
    try {
      await api(`/uploads/${item.sessionId}`, { method: 'DELETE' })
    } catch { /* it may already be gone */ }
    forget(item.sessionId)
  }
  items.delete(id)
  emit()
}

/**
 * Drop finished and failed rows. The shared indicator counts BOTH upload
 * stores but Clear only ever emptied the image one, so a completed loop or a
 * failed chunked upload stayed in the count for the rest of the session and no
 * button in the interface could remove it.
 */
export function clearFinished(): void {
  for (const [id, it] of items) {
    if (it.status === 'done' || it.status === 'error') items.delete(id)
  }
  emit()
}

/** Re-drive whatever failed. The counterpart of Retry for the other store. */
export function retryFailed(): void {
  for (const it of items.values()) {
    if (it.status !== 'error') continue
    if (!it.file) {
      // Resumable sessions survive a reload but the FILE does not: the browser
      // will not hand it back without the user choosing it again. Say so rather
      // than silently doing nothing when the button is pressed.
      it.error = 'Choose the file again to resume this upload'
      continue
    }
    it.status = 'queued'
    it.error = null
    void drive(it)
  }
  emit()
}

// ---------------------------------------------------------------------------
//  Leaving the page
// ---------------------------------------------------------------------------
/**
 * Warn before a real unload, and only when it would actually cost something.
 *
 * Not shown when the browser is carrying the transfer, because then leaving
 * costs nothing — and a warning that fires when there is nothing to lose is how
 * people learn to dismiss warnings without reading them.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    const risky = inFlight().filter(i => !i.background)
    if (!risky.length) return
    e.preventDefault()
    e.returnValue = ''
  })
}
