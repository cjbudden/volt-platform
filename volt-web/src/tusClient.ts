/* ============================================================================
   A SMALL tus 1.0.0 CLIENT, dependency free.

   The console's own panel keeps the chunk protocol (three chunks in flight,
   Background Fetch on Chromium), which is faster for one big file than tus's
   sequential PATCHes. This client exists for the other cases: the phone
   browser, where sequential and resumable is exactly right; embedding in a
   customer page without our panel; and as the reference for anyone pointing
   an official tus client at /api/tus.

   RESUME IS THE NORMAL PATH, not the exception. The upload URL is remembered
   per file (name + size + modified) so a reload, a suspended Safari tab or a
   dropped connection continues from the server's offset after one HEAD.
   ========================================================================== */

export interface TusClientOptions {
  endpoint: string                       // '/api/tus'
  token: string                          // console JWT or account key
  metadata?: Record<string, string>      // filename, filetype, relativePath, schemaId, source, metadata(JSON)
  chunkSize?: number                     // default: 8 MB, 4 MB on a cellular connection
  checksum?: boolean                     // send Upload-Checksum sha256 per PATCH
  retries?: number
  onProgress?: (sent: number, total: number) => void
  onEvent?: (event: string, detail?: any) => void
  signal?: AbortSignal
  /** Storage for the resume key; defaults to localStorage when present. */
  store?: { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void }
}

export interface TusResult { url: string; sha256?: string }

const enc = (m: Record<string, string>) =>
  Object.entries(m).map(([k, v]) => `${k} ${btoa(unescape(encodeURIComponent(String(v))))}`).join(',')

export function isCellular(): boolean {
  const c = (navigator as any).connection
  return !!c && (c.type === 'cellular' || /^(slow-2g|2g|3g)$/.test(c.effectiveType ?? ''))
}

function fingerprint(file: File, endpoint: string): string {
  return `tus:${endpoint}:${file.name}:${file.size}:${file.lastModified}`
}

const defaultStore = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* */ } },
}

async function sha256b64(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return btoa(String.fromCharCode(...new Uint8Array(d)))
}

export async function tusUpload(file: File, o: TusClientOptions): Promise<TusResult> {
  const store = o.store ?? defaultStore
  const H = { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${o.token}` }
  const chunk = o.chunkSize ?? (isCellular() ? 4 * 1024 * 1024 : 8 * 1024 * 1024)
  const retries = o.retries ?? 5
  const key = fingerprint(file, o.endpoint)
  const emit = (e: string, d?: any) => o.onEvent?.(e, d)

  // 1. Find or create the upload.
  let url = store.get(key)
  let offset = 0
  if (url) {
    const h = await fetch(url, { method: 'HEAD', headers: H, signal: o.signal }).catch(() => null)
    if (h && h.ok) { offset = Number(h.headers.get('Upload-Offset') ?? 0); emit('restored', { from: offset }) }
    else { store.del(key); url = null }
  }
  if (!url) {
    const md = { filename: file.name, filetype: file.type || 'application/octet-stream',
                 ...((file as any).webkitRelativePath ? { relativePath: (file as any).webkitRelativePath } : {}), ...(o.metadata ?? {}) }
    const r = await fetch(o.endpoint, { method: 'POST', headers: { ...H, 'Upload-Length': String(file.size), 'Upload-Metadata': enc(md) }, signal: o.signal })
    if (!r.ok) throw new Error(`tus create failed (${r.status}): ${await r.text().catch(() => '')}`)
    const loc = r.headers.get('Location')!
    url = loc.startsWith('http') ? loc : new URL(loc, location.origin).toString()
    store.set(key, url)
    emit('started', { url })
  }

  // 2. Sequential PATCHes from the server's offset, re-syncing on 409.
  let attempt = 0
  while (offset < file.size) {
    if (o.signal?.aborted) throw new Error('cancelled')
    const end = Math.min(offset + chunk, file.size)
    const part = file.slice(offset, end)
    const headers: Record<string, string> = { ...H, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) }
    if (o.checksum) headers['Upload-Checksum'] = 'sha256 ' + await sha256b64(part)
    let r: Response | null = null
    try { r = await fetch(url, { method: 'PATCH', headers, body: part, signal: o.signal }) } catch (e) { r = null }
    if (r && r.status === 204) {
      offset = Number(r.headers.get('Upload-Offset') ?? end); attempt = 0
      o.onProgress?.(offset, file.size); emit('progress', { sent: offset, total: file.size })
      continue
    }
    if (r && r.status === 409) { offset = Number(r.headers.get('Upload-Offset') ?? offset); continue }   // re-sync, no attempt spent
    if (r && r.status === 460) { attempt++; if (attempt > retries) throw new Error('checksum kept failing'); continue }
    if (r && (r.status === 404 || r.status === 410)) { store.del(key); throw new Error('the upload expired on the server; start it again') }
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`tus patch failed (${r.status}): ${await r.text().catch(() => '')}`)
    // network error or 5xx: back off, then ask the server where it is.
    attempt++
    if (attempt > retries) throw new Error('connection kept failing; the upload can be resumed later')
    emit('paused', { reason: r ? `HTTP ${r.status}` : 'offline', retryIn: 1000 * 2 ** attempt })
    await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * 2 ** attempt)))
    const h = await fetch(url, { method: 'HEAD', headers: H, signal: o.signal }).catch(() => null)
    if (h && h.ok) { offset = Number(h.headers.get('Upload-Offset') ?? offset); emit('resumed', { from: offset }) }
  }
  store.del(key)
  emit('transferred', { url })
  return { url }
}
