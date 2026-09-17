// A tus 1.0.0 client for Node: resumable, sequential PATCHes from disk, one
// HEAD to resume. Mirrors volt-web/src/tusClient.ts.
import { open, stat } from 'node:fs/promises';

export interface TusOpts { endpoint: string; token: string; metadata?: Record<string, string>; chunkBytes?: number; retries?: number; resumeUrl?: string | null; onProgress?: (sent: number, total: number) => void; fetch?: typeof fetch }

const enc = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${Buffer.from(String(v), 'utf8').toString('base64')}`).join(',');

export async function tusUploadFile(path: string, o: TusOpts): Promise<{ url: string }> {
  const f = o.fetch ?? fetch;
  const H = { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${o.token}` };
  const size = (await stat(path)).size;
  const chunk = o.chunkBytes ?? 8 * 1024 * 1024;
  let url = o.resumeUrl ?? null; let offset = 0;
  if (url) { const h = await f(url, { method: 'HEAD', headers: H }).catch(() => null); if (h?.ok) offset = Number(h.headers.get('Upload-Offset') ?? 0); else url = null; }
  if (!url) {
    const r = await f(o.endpoint, { method: 'POST', headers: { ...H, 'Upload-Length': String(size), 'Upload-Metadata': enc({ filename: path.split(/[\\/]/).pop()!, ...(o.metadata ?? {}) }) } });
    if (!r.ok) throw new Error(`tus create failed (${r.status})`);
    const loc = r.headers.get('Location')!; url = loc.startsWith('http') ? loc : new URL(loc, o.endpoint).toString();
  }
  const fh = await open(path, 'r');
  let attempt = 0;
  try {
    while (offset < size) {
      const len = Math.min(chunk, size - offset); const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      let r: Response | null = null;
      try { r = await f(url, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), 'Content-Length': String(len) }, body: buf }); } catch { r = null; }
      if (r?.status === 204) { offset = Number(r.headers.get('Upload-Offset') ?? offset + len); attempt = 0; o.onProgress?.(offset, size); continue; }
      if (r?.status === 409) { offset = Number(r.headers.get('Upload-Offset') ?? offset); continue; }
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`tus patch failed (${r.status})`);
      if (++attempt > (o.retries ?? 6)) throw new Error('connection kept failing');
      await new Promise((res) => setTimeout(res, Math.min(30000, 500 * 2 ** attempt)));
      const h = await f(url, { method: 'HEAD', headers: H }).catch(() => null); if (h?.ok) offset = Number(h.headers.get('Upload-Offset') ?? offset);
    }
  } finally { await fh.close(); }
  return { url };
}
