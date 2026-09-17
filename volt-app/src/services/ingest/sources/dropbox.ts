import { type RemoteSource, type RemoteRef, type RemoteDescription, type Fetch, type Auth, type LocateQuery, type LocateHit, RemoteError } from './types';

const API = 'https://api.dropboxapi.com/2';

/** Dropbox: temporary links honour Range; search and get-by-path exist natively. */
export class DropboxSource implements RemoteSource {
  readonly provider = 'dropbox' as const;
  constructor(private fetch: Fetch, private api = API) {}
  private async call(auth: Auth | null, ep: string, body: any) {
    if (!auth) throw new RemoteError('Dropbox is not linked to this account', 401, false);
    const res = await this.fetch(`${this.api}/${ep}`, { method: 'POST', headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new RemoteError(`Dropbox ${ep} answered HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429);
    return res.json();
  }
  async describe(ref: RemoteRef, auth: Auth | null): Promise<RemoteDescription> {
    const a = ref.token ? { accessToken: ref.token } : auth;
    const j: any = await this.call(a, 'files/get_temporary_link', { path: ref.ref });
    return { name: j.metadata?.name ?? 'download', bytes: Number(j.metadata?.size ?? 0) || null, mime: null, ranges: true, modified: j.metadata?.client_modified ?? null, downloadUrl: j.link };
  }
  async locate(q: LocateQuery, auth: Auth): Promise<LocateHit | null> {
    // By path first (the agent and folder drops give one), then by name.
    if (q.relativePath) {
      const p = '/' + q.relativePath.replace(/^\/+/, '');
      try {
        const m: any = await this.call(auth, 'files/get_metadata', { path: p });
        if (m['.tag'] === 'file' && (q.bytes == null || Number(m.size) === q.bytes)) return { ref: { provider: 'dropbox', ref: m.id }, name: m.name, bytes: Number(m.size), path: m.path_display, strength: 'path' };
      } catch { /* not there under that path */ }
    }
    const s: any = await this.call(auth, 'files/search_v2', { query: q.name, options: { filename_only: true, max_results: 20, file_status: 'active' } });
    const files = (s.matches ?? []).map((x: any) => x.metadata?.metadata).filter((m: any) => m && m['.tag'] === 'file' && m.name.toLowerCase() === q.name.toLowerCase());
    const exact = q.bytes != null ? files.find((m: any) => Number(m.size) === q.bytes) : null;
    const m = exact ?? (files.length === 1 ? files[0] : null);
    if (!m) return null;
    return { ref: { provider: 'dropbox', ref: m.id }, name: m.name, bytes: Number(m.size), path: m.path_display, strength: exact ? 'name_and_size' : 'name' };
  }
}
