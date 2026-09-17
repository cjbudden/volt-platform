import { type RemoteSource, type RemoteRef, type RemoteDescription, type Fetch, RemoteError, filenameFromDisposition } from './types';

/** Any HTTP(S) link: HEAD first for size, type and Range support, then GET. */
export class UrlSource implements RemoteSource {
  readonly provider = 'url' as const;
  constructor(private fetch: Fetch) {}
  async describe(ref: RemoteRef): Promise<RemoteDescription> {
    const u = new URL(ref.ref);
    if (!/^https?:$/.test(u.protocol)) throw new RemoteError('only http and https links can be fetched', 400, false);
    let res = await this.fetch(ref.ref, { method: 'HEAD', headers: ref.headers ?? {}, redirect: 'follow' });
    let viaGet = false;
    if (!res.ok || res.status === 405) { res = await this.fetch(ref.ref, { method: 'GET', headers: { ...(ref.headers ?? {}), Range: 'bytes=0-0' }, redirect: 'follow' }); viaGet = true; }
    if (!res.ok) throw new RemoteError(`the link answered HTTP ${res.status}`, res.status, res.status >= 500);
    const len = viaGet && res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) : Number(res.headers.get('content-length'));
    const fallback = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'download');
    return {
      name: filenameFromDisposition(res.headers.get('content-disposition'), fallback),
      bytes: Number.isFinite(len) && len > 0 ? len : null,
      mime: res.headers.get('content-type')?.split(';')[0] ?? null,
      ranges: (res.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes' || res.status === 206,
      modified: res.headers.get('last-modified'),
      downloadUrl: ref.ref, downloadHeaders: ref.headers,
    };
  }
}
